import "server-only";
import { appendFile, readFile, stat } from "node:fs/promises";
import { appendAudit, type AuditAnchorRef } from "@/lib/audit";
import type { Db } from "@/lib/db";

// 監査の記録の先頭の控え（docs/adr/0001-audit-chain-mac.md）。
// 最後の行の seq と hash を、データベースの外へ定期に書き出す。書き出し先は2つ：
// - コンテナのログ（標準出力）：`tsunagi-dicom: audit-anchor {"seq":…,"hash":…,"keyId":…,"at":…}` の1行。
//   施設が、ログを外の置き場（syslog・追記だけのストレージ・別のホスト）へ送って残す（運用に任せる）。
// - AUDIT_ANCHOR_FILE（設定したとき）：同じ JSON を1行ずつ追記するファイル。データベースとは別のボリュームに置く。
//   /api/audit/verify は、このファイルの控えと照らし合わせる。
// 控えは、末尾の削除（切り詰め）と、鍵を持つ者による作り直しを見つけるためのもの。控えより後に書かれた行は、
// 次の控えまで照らせない。

export interface AuditAnchor extends AuditAnchorRef {
  /** その行の鍵の印（鍵つきにする前の行は null） */
  keyId: string | null;
  /** 控えを書いた時刻（ISO 8601、UTC） */
  at: string;
}

/** 控えを書き出す間隔（最後の行が変わっていなければ書かない） */
export const AUDIT_ANCHOR_INTERVAL_MS = 10 * 60_000;
export const AUDIT_ANCHOR_LOG_PREFIX = "tsunagi-dicom: audit-anchor ";

const HASH = /^[0-9a-f]{64}$/;

export class AuditAnchorFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditAnchorFileError";
  }
}

// 同じプロセスで同じ先頭を重ねて書かない（Next.js がこのモジュールを2つ組んでも1つにする）
const STATE_KEY = Symbol.for("tsunagi-dicom.audit-anchor");
const stateHolder = globalThis as typeof globalThis & { [STATE_KEY]?: { lastSeq: number | null } };
const state = (stateHolder[STATE_KEY] ??= { lastSeq: null });

/**
 * いまの最後の行の控えを書き出す。行が無いか、前に書いた控えから変わっていなければ書かない（null を返す）。
 * file への追記に失敗したら投げる（ログには先に書く）
 */
export async function writeAuditAnchor(
  db: Db,
  file: string | undefined,
  log: (line: string) => void = (line) => console.info(line),
  now: Date = new Date(),
): Promise<AuditAnchor | null> {
  // 控えのファイルが無ければ、初めて書き出すときだけ作る（作ったことを監査の記録に残す）。前に書き出したことがあれば、
  // 作り直さない：消えたファイルや別のボリュームを、いまの（切り詰められたかもしれない）先頭から黙って作り直すと、
  // /api/audit/verify が照らせないことに気づけないため
  let create = false;
  if (file && !(await exists(file))) {
    if (await db.auditLog.findFirst({ where: { action: "audit_anchor" }, select: { seq: true } })) {
      throw new AuditAnchorFileError(
        "先頭の控えのファイルが無い（前に書き出したことがある）。作り直さない。外に残したログの控えと照らしてから、続けるなら空のファイルを置く",
      );
    }
    await appendAudit(db, { actorId: "system", actorRole: "system", authMode: "system", action: "audit_anchor", detail: { event: "start" } });
    create = true;
  }
  const last = await db.auditLog.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true, keyId: true } });
  if (!last || (!create && state.lastSeq === last.seq)) return null;
  const anchor: AuditAnchor = { seq: last.seq, hash: last.hash, keyId: last.keyId, at: now.toISOString() };
  const line = JSON.stringify(anchor);
  log(`${AUDIT_ANCHOR_LOG_PREFIX}${line}`);
  // 作るときは、ほかのプロセスが同じ時に作っていたら失敗させる（wx）
  if (file) await appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600, flag: create ? "wx" : "a" });
  state.lastSeq = last.seq;
  return anchor;
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** 試験で、前に書いた控えの覚えを消す */
export function resetAuditAnchorState(): void {
  state.lastSeq = null;
}

/**
 * AUDIT_ANCHOR_FILE の控えを読む。ファイルがまだ無ければ空（最初の控えを書く前）。
 * 読めない行・同じ seq で hash の違う行があれば投げる（控えのファイルが書き換えられた）
 */
export async function readAuditAnchors(file: string): Promise<AuditAnchorRef[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AuditAnchorFileError("先頭の控えのファイルを読めない");
  }
  const bySeq = new Map<number, string>();
  const lines = text.split("\n");
  for (const [i, raw] of lines.entries()) {
    if (raw === "" && i === lines.length - 1) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const a = parsed as { seq?: unknown; hash?: unknown } | null;
    if (!a || !Number.isSafeInteger(a.seq) || (a.seq as number) < 1 || typeof a.hash !== "string" || !HASH.test(a.hash)) {
      throw new AuditAnchorFileError(`先頭の控えのファイルの ${i + 1} 行目が読めない`);
    }
    const seen = bySeq.get(a.seq as number);
    if (seen !== undefined && seen !== a.hash) {
      throw new AuditAnchorFileError(`先頭の控えのファイルに、seq ${String(a.seq)} の控えが食い違って2つある`);
    }
    bySeq.set(a.seq as number, a.hash);
  }
  return [...bySeq].map(([seq, hash]) => ({ seq, hash }));
}

/**
 * 起動の時に1回と、その後は一定の間隔で控えを書き出す。起動の時の1回は、要求を受ける前に書き終える
 * （/api/audit/verify は、行があるのに控えが無いことを食い違いとして返すため）。失敗しても次の間隔でやり直す
 */
export async function startAuditAnchors(getDb: () => Promise<Db>, file: string | undefined): Promise<void> {
  const tick = () =>
    (async () => writeAuditAnchor(await getDb(), file))().catch((error: unknown) =>
      console.error("tsunagi-dicom: 監査の記録の先頭の控えを書き出せなかった", error instanceof Error ? error.message : error),
    );
  await tick();
  const timer = setInterval(() => void tick(), AUDIT_ANCHOR_INTERVAL_MS);
  timer.unref();
}
