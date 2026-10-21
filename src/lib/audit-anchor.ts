import "server-only";
import { appendFile, readFile, stat, writeFile } from "node:fs/promises";
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
 * ログ（標準出力）には、控えのファイルの具合に関わらず書く。ファイルに書けなければ、ログに書いた後で投げる
 */
export async function writeAuditAnchor(
  db: Db,
  file: string | undefined,
  log: (line: string) => void = (line) => console.info(line),
  now: Date = new Date(),
): Promise<AuditAnchor | null> {
  // 控えのファイルが無ければ、記録も利用者もまだ無い（初めての起動）ときだけ作る（作ったことを監査の記録に残す）。
  // 記録か利用者があるのにファイルが無ければ、作らない：消えたファイルや別のボリュームを、いまの（切り詰められたり、
  // 作り直されたりしたかもしれない）データベースの先頭から黙って作り直すと、/api/audit/verify が照らせないことに
  // 気づけないため（データベースだけを見て「初めて」かを決めると、データベースを書き換えられる者に初めてを装われる）。
  // 前の版から上げたときなど、記録がある一式で控えを始めるときは、施設が空のファイルを置く（空のファイルには書く）。
  // 作るときは、空のファイルを先に作ってから記録の行を足す（記録の行を足した後にファイルを作れないと、次から
  // 「前に作った」と見て二度と作れなくなるため。空のファイルができていれば、次からはそこへ追記する）
  // ファイルの側の失敗は、ログ（標準出力）に書いた後で投げる。lost は「前に作ったのに無い」（作り直さない）
  let fileProblem: unknown = null;
  let lost = false;
  // 空のファイル（作ったばかり・施設が置き直した）には、先頭が変わっていなくても書く
  let force = false;
  if (file) {
    try {
      const size = await sizeOf(file);
      force = size === 0;
      if (size === null) {
        force = true;
        if (await db.auditLog.findFirst({ where: { action: "audit_anchor" }, select: { seq: true } })) {
          lost = true;
          fileProblem = new AuditAnchorFileError(
            "先頭の控えのファイルが無い（前に書き出したことがある）。作り直さない。外に残したログの控えと照らしてから、続けるなら空のファイルを置く",
          );
        } else if ((await db.auditLog.count()) > 0 || (await db.user.count()) > 0) {
          // 記録か利用者があるのにファイルが無い。作らなかったことを記録に残す（次の回からは「前に書き出したことがある」
          // として扱い、記録が増えた後にも作り直さない）
          await appendAudit(db, {
            actorId: "system",
            actorRole: "system",
            authMode: "system",
            action: "audit_anchor",
            outcome: "denied",
            detail: { event: "missing" },
          });
          lost = true;
          fileProblem = new AuditAnchorFileError(
            "監査の記録か利用者があるのに、先頭の控えのファイルが無いので作らない。控えを初めて始めるとき（前の版から上げたときなど）や、" +
              "消えたファイルの後を続けるときは、外に残したログの控えと照らしてから空のファイルを置く",
          );
        } else {
          // ほかのプロセスが同じ時に作っていれば（EEXIST）、そのファイルへ追記する
          await writeFile(file, "", { mode: 0o600, flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          });
          await appendAudit(db, { actorId: "system", actorRole: "system", authMode: "system", action: "audit_anchor", detail: { event: "start" } });
        }
      }
    } catch (error) {
      fileProblem = error;
    }
  }
  const last = await db.auditLog.findFirst({ orderBy: { seq: "desc" }, select: { seq: true, hash: true, keyId: true } });
  const unchanged = last !== null && state.lastSeq === last.seq;
  if (!last || (unchanged && (!force || lost))) {
    if (fileProblem) throw fileProblem;
    return null;
  }
  const anchor: AuditAnchor = { seq: last.seq, hash: last.hash, keyId: last.keyId, at: now.toISOString() };
  const line = JSON.stringify(anchor);
  log(`${AUDIT_ANCHOR_LOG_PREFIX}${line}`);
  if (lost) {
    // ログには書けた。ファイルは作り直さないので、同じ先頭をログに重ねて書かない
    state.lastSeq = last.seq;
  }
  // ほかのファイルの失敗（置き場が無い・権限など）は、次の間隔で同じ先頭をもう一度書く（覚えるのは書けた後）
  if (fileProblem) throw fileProblem;
  if (file) await appendFile(file, `${line}\n`, { encoding: "utf8", mode: 0o600, flag: "a" });
  state.lastSeq = last.seq;
  return anchor;
}

/** ファイルの大きさ（バイト）。無ければ null */
async function sizeOf(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
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
