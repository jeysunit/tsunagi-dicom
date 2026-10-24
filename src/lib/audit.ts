import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { auditKeyring, type AuditKey, type AuditKeyring } from "@/lib/audit-key";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db";

// 監査の記録（docs/spec.md の 3.6「監査の記録」、第7.0版 17 遵守事項①②。設計は docs/adr/0001-audit-chain-mac.md）。
// 誰が・いつ・どの患者と検査に・何をしたを、追記だけで残す。
// 各行は前の行の hash を prevHash に持ち、行の中身と prevHash の HMAC-SHA256（鍵は SESSION_SECRET から導く。
// src/lib/audit-key.ts）を hash にする。行には鍵の印（keyId）を持たせる。
// 鍵を持たない者による書き換え・途中の削除・差し込みは verifyAuditChain で見つかる。末尾の削除（切り詰め）と、
// 鍵を持つ者による作り直しは、データベースの外に書き出した先頭の控え（src/lib/audit-anchor.ts）と照らして見つける。
// 鍵つきにする前の行（keyId が空）は、鍵の無い SHA-256 のまま確かめる（追記だけの決まりのため書き換えない）。
// このモジュールには追記と確かめだけを置き、更新・削除の関数は作らない。

export const AUDIT_ACTIONS = [
  "hl7",
  "login",
  "logout",
  "search",
  "view_study",
  "open_viewer",
  "modify",
  "delete",
  "import",
  "config_change",
  "role_switch",
  "write",
  // ビューアが画像を取る道（WADO-RS の読み取りの中継）
  "retrieve",
  // AUTH_MODE=local（段 1b）：ログインの一時停止とその解除・画面のロックと解除・TOTP の登録とやり直し・パスワードの変更
  "login_lock",
  "login_unlock",
  "screen_lock",
  "screen_unlock",
  "mfa_enroll",
  "mfa_reset",
  "password_change",
  // 大事な操作の前の、もう一度の本人の確かめ（段 1b）
  "reauth",
  // 利用者の管理（段 1b）：作る・止める／戻す・役割の変更
  "user_create",
  "user_status_change",
  "role_change",
  // 段 2：検査ごとのビューアの覚えの変更（detail の flag は viewer）。BFF のデータベースだけを変える。
  // 段 2 の検査の状態の印（検像・読影・緊急・ブックマーク）の変更も、段 3 で道を外すまでこの名前で記録した
  "study_state",
  // 段 4（docs/spec.md の 3.3〜3.5）：受け取りの記録を開いた・機器へ C-ECHO・ほかの機器へ送る（detail の phase：
  // request＝Orthanc を呼ぶ前、result＝呼んだ後、done＝仕事の終わりを読んだ、reconcile＝結果不明を照らした）
  "receive_log",
  "echo",
  "send",
  // 段 5：書き出し（ZIP）。削除は上の delete（detail の phase は send と同じ）
  "export",
  // つなぎの鍵が替わった（鍵つきにした・SESSION_SECRET を替えた）。detail の from（前の行の keyId。鍵の無い行なら sha256）と to
  "audit_key",
  // 先頭の控えのファイル（AUDIT_ANCHOR_FILE）を初めて作った（detail の event は start。src/lib/audit-anchor.ts）
  "audit_anchor",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
/**
 * success：通した。denied：このアプリが断った。failed：画像サーバーが失敗を返した・つながらなかった。
 * unknown：書き込みの操作で、Orthanc を呼んだ後の結果が分からない（docs/spec.md の 3.5 の結果不明）
 */
export type AuditOutcome = "success" | "denied" | "failed" | "unknown";

/** 最初の行の prevHash */
export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntryInput {
  actorId: string;
  actorRole: string;
  authMode: string;
  action: AuditAction;
  outcome?: AuditOutcome;
  patientId?: string | null;
  studyInstanceUid?: string | null;
  /** 確かめた接続元。信じるプロキシの設定が無い間は null（src/lib/auth/source-address.ts） */
  sourceAddress?: string | null;
  /** 要求のヘッダーにあった接続元（X-Forwarded-For など）。偽れるので、確かめていない値として分けて持つ */
  sourceAddressUnverified?: string | null;
  detail?: Record<string, unknown> | null;
  /** 既定はサーバーの時計の今 */
  occurredAt?: Date;
}

export interface AuditRow {
  seq: number;
  occurredAt: Date;
  actorId: string;
  actorRole: string;
  authMode: string;
  action: string;
  outcome: string;
  patientId: string | null;
  studyInstanceUid: string | null;
  sourceAddress: string | null;
  detail: string | null;
  prevHash: string;
  hash: string;
  sourceAddressUnverified: string | null;
  /** hash を計算した鍵の印。null は鍵つきにする前の、鍵の無い SHA-256 の行 */
  keyId: string | null;
}

/** hash の元にする行。後から足した項目は、無い（null の）行では省ける */
export type AuditHashInput = Omit<AuditRow, "hash" | "sourceAddressUnverified" | "keyId"> &
  Partial<Pick<AuditRow, "sourceAddressUnverified" | "keyId">>;

/**
 * 鍵つきにする前の行（keyId が空）の hash：鍵の無い SHA-256。古い行を確かめるためだけに使う。
 * 項目を足すときは末尾に足し、古い行の確かめ方を変えない：
 * 後から足した項目は、値があるときだけ並びに入れる（値の無い行は、足す前と同じ hash になる）
 */
export function computeAuditHash(row: AuditHashInput): string {
  const later = row.sourceAddressUnverified != null ? [row.sourceAddressUnverified] : [];
  const payload = JSON.stringify([
    row.seq,
    row.occurredAt.toISOString(),
    row.actorId,
    row.actorRole,
    row.authMode,
    row.action,
    row.outcome,
    row.patientId,
    row.studyInstanceUid,
    row.sourceAddress,
    row.detail,
    row.prevHash,
    ...later,
  ]);
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * 鍵つきの行の hash：HMAC-SHA256。並びの形は固定（先頭に形の印 v1、末尾に確かめていない接続元と鍵の印）。
 * 鍵の印も並びに入れ、行の keyId を別の鍵の印に書き換えられないようにする
 */
export function computeAuditMac(row: AuditHashInput, key: AuditKey): string {
  const payload = JSON.stringify([
    "v1",
    row.seq,
    row.occurredAt.toISOString(),
    row.actorId,
    row.actorRole,
    row.authMode,
    row.action,
    row.outcome,
    row.patientId,
    row.studyInstanceUid,
    row.sourceAddress,
    row.detail,
    row.prevHash,
    row.sourceAddressUnverified ?? null,
    key.id,
  ]);
  return createHmac("sha256", key.key).update(payload, "utf8").digest("hex");
}

/** 長さの違う値（書き換えで 16 進でない字を入れられた値を含む）は、比べずに違うとする */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

// 1つのプロセスの中で追記を一列に並べる（前の行の hash を読んでから書くため）。
// ほかのプロセスと競ったときは prevHash の一意の制約で失敗し、つなぎは枝分かれしない。
// Next.js は起動の時の処理（instrumentation の定期の片付け）と route handler を別々に組むことがあり、
// そのときこのモジュールは2つになるので、並びは globalThis に1つだけ置く
const QUEUE_KEY = Symbol.for("tsunagi-dicom.audit-queue");
const queueHolder = globalThis as typeof globalThis & { [QUEUE_KEY]?: { tail: Promise<unknown> } };
const queue = (queueHolder[QUEUE_KEY] ??= { tail: Promise.resolve() });

export function appendAudit(db: Db, input: AuditEntryInput): Promise<AuditRow> {
  return appendAuditWith(db, async () => ({ value: undefined, input })).then((r) => r.row);
}

/** 1つの transaction の中の Prisma の client */
export type Tx = Prisma.TransactionClient;

/**
 * BFF のデータベースの変更と、その監査の記録の1行を、1つの transaction で書く。
 * write が変更を書き、記録する中身（成功・断った など）を返す。どちらかが失敗したら両方とも書かない
 * （変わったのに記録が無い、を作らない）。競合で書かなかったときは、write は投げずにその旨の記録を返す
 * （わざと取り消すと、同じつなぎに入ったほかの要求の文まで消えうるため。docs/spec.md の 3.6 のセッション）
 */
export function appendAuditWith<T>(
  db: Db,
  write: (tx: Tx) => Promise<{ value: T; input: AuditEntryInput }>,
): Promise<{ value: T; row: AuditRow }> {
  return appendAuditIf(db, write) as Promise<{ value: T; row: AuditRow }>;
}

/** 前の行に続く1行を、鍵つきで書く */
async function createRow(tx: Tx, last: AuditRow | null, input: AuditEntryInput, key: AuditKey): Promise<AuditRow> {
  const base: Omit<AuditRow, "hash"> = {
    sourceAddressUnverified: input.sourceAddressUnverified ?? null,
    seq: (last?.seq ?? 0) + 1,
    occurredAt: input.occurredAt ?? new Date(),
    actorId: input.actorId,
    actorRole: input.actorRole,
    authMode: input.authMode,
    action: input.action,
    outcome: input.outcome ?? "success",
    patientId: input.patientId ?? null,
    studyInstanceUid: input.studyInstanceUid ?? null,
    sourceAddress: input.sourceAddress ?? null,
    detail: input.detail ? JSON.stringify(input.detail) : null,
    prevHash: last?.hash ?? GENESIS_HASH,
    keyId: key.id,
  };
  return tx.auditLog.create({ data: { ...base, hash: computeAuditMac(base, key) } });
}

/**
 * appendAuditWith と同じ並びと transaction で、write が input に null を返したときは記録を足さない
 * （記録の並びの中で「もう書いてあるか」を確かめてから書くため。docs/spec.md の 3.5。送った仕事の終わりの記録など）
 */
export function appendAuditIf<T>(
  db: Db,
  write: (tx: Tx) => Promise<{ value: T; input: AuditEntryInput | null }>,
): Promise<{ value: T; row: AuditRow | null }> {
  let switched = false;
  const run = queue.tail.then(() =>
    db.$transaction(async (tx) => {
      const { value, input } = await write(tx);
      if (input === null) return { value, row: null };
      const key = auditKeyring().current;
      let last: AuditRow | null = await tx.auditLog.findFirst({ orderBy: { seq: "desc" } });
      // 前の行と鍵が違えば（鍵つきにする前の行・SESSION_SECRET を替えた後）、先に鍵が替わったことを1行書く
      if (last && last.keyId !== key.id) {
        switched = true;
        last = await createRow(
          tx,
          last,
          {
            actorId: "system",
            actorRole: "system",
            authMode: input.authMode,
            action: "audit_key",
            detail: { from: last.keyId ?? "sha256", to: key.id },
          },
          key,
        );
      }
      const row = await createRow(tx, last, input, key);
      return { value, row };
    }),
  );
  queue.tail = run.catch(() => undefined);
  // 鍵が替わったことの行を書いたら、すぐに先頭の控えを書き出す（次の定期の書き出しを待たない）。
  // 切り替えの位置をデータベースの外に残し、切り替えの後の行を鍵の無い形に作り直されても見つけるため。
  // 控えの書き出しは並びの外で行う（控えの側が記録を足すことがあるので、並びの中で待つと止まる）
  return run.then(async (result) => {
    if (switched) await anchorAfterKeySwitch(db);
    return result;
  });
}

async function anchorAfterKeySwitch(db: Db): Promise<void> {
  try {
    const { writeAuditAnchor } = await import("@/lib/audit-anchor");
    await writeAuditAnchor(db, getConfig().audit?.anchorFile);
  } catch (error) {
    console.error("tsunagi-dicom: 鍵が替わった後の先頭の控えを書き出せなかった", error instanceof Error ? error.message : error);
  }
}

/** データベースの外に書き出した先頭の控え（src/lib/audit-anchor.ts） */
export interface AuditAnchorRef {
  seq: number;
  hash: string;
}

export interface AuditChainOptions {
  /** 確かめに使う鍵の束。既定は設定から作ったもの */
  keyring?: AuditKeyring;
  /** 照らし合わせる先頭の控え */
  anchors?: readonly AuditAnchorRef[];
  /**
   * 控えがあるはずか（控えのファイルを設定しているとき）。行があるのに控えが1つも無ければ、食い違いとして返す
   * （控えのファイルが消えた・別のファイルを見ているときに、照らさずに通すと、切り詰めや作り直しを見落とすため）。
   * 控えを1つ以上渡したときも、設定しているとみなす
   */
  requireAnchors?: boolean;
}

/**
 * 先頭の控えと照らした結果。checked：照らした（控えの seq の行が全部合った）。not-configured：控えのファイルを
 * 設定していないので照らしていない（末尾の削除と、鍵を持つ者による作り直しは確かめていない）。no-rows：行がまだ無い
 */
export type AuditAnchorStatus = "checked" | "not-configured" | "no-rows";

export type AuditChainResult =
  | {
      ok: true;
      checked: number;
      /** 鍵つきにする前の、鍵の無い SHA-256 の行の数（作り直しを見つけられない行） */
      legacy: number;
      /** 先頭の控えと照らしたか、照らした控えの数と、いちばん新しい控えの seq（控えが無ければ 0 と null） */
      anchors: { status: AuditAnchorStatus; checked: number; latestSeq: number | null };
    }
  | { ok: false; checked: number; seq: number; reason: string };

/**
 * つなぎを頭から確かめる。最初に見つかった食い違いを返す。
 * - 鍵つきの行は、行の鍵の印の鍵で hash を確かめる。受け付ける鍵は設定で決まる（SESSION_SECRET と
 *   SESSION_SECRET_PREVIOUS_FILE）。知らない鍵の印の行は、確かめられないので食い違いとして返す。
 * - 鍵の印が替わってよいのは、鍵が替わったことの行（audit_key）だけ。その行は、新しい鍵で書かれ、detail の from が
 *   前の行の鍵の印（鍵の無い行なら sha256）、to が自分の鍵の印と同じでなければならない。前に使い終えた鍵へは戻れない。
 *   そのため、前の鍵（漏れたかもしれない）を名乗って、取り替えの後に行を書き足したり、取り替えの行を作ったりできない。
 * - 鍵の無い行（前の版の形）は、最初の鍵つきの行より前だけで受ける。鍵つきの行の後に鍵の無い行があれば、作り直しとして返す。
 *   鍵の無い行を前から全部作り直された（鍵つきの行を消した）ときは、つなぎだけでは見つからず、先頭の控えで見つける。
 * - 先頭の控えを渡せば、控えの seq の行の hash が控えと同じか、控えより行が少なくないか（末尾の削除）も確かめる
 *   （鍵つきの hash には鍵の印も入るので、鍵の印を書き換えると hash も変わる）。結果の anchors.status で、控えと照らしたかが分かる。
 */
export async function verifyAuditChain(db: Db, batchSize = 1000, options: AuditChainOptions = {}): Promise<AuditChainResult> {
  const keyring = options.keyring ?? auditKeyring();
  const anchors = new Map<number, string>();
  for (const a of options.anchors ?? []) anchors.set(a.seq, a.hash);
  let firstAnchorSeq: number | null = null;
  for (const seq of anchors.keys()) firstAnchorSeq = firstAnchorSeq === null ? seq : Math.min(firstAnchorSeq, seq);
  let anchorsChecked = 0;
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let checked = 0;
  let legacy = 0;
  /** いまの鍵の印（null は鍵の無い行の間）と、使い終えた鍵の印 */
  let currentKeyId: string | null = null;
  const retired = new Set<string>();
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: { seq: { gte: expectedSeq } },
      orderBy: { seq: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, checked, seq: expectedSeq, reason: `seq ${expectedSeq} の行が無い（消された）` };
      }
      if (row.prevHash !== prevHash) {
        return { ok: false, checked, seq: row.seq, reason: "prevHash が前の行の hash と合わない" };
      }
      const { hash, ...rest } = row;
      if (row.keyId === null) {
        if (currentKeyId !== null) {
          return { ok: false, checked, seq: row.seq, reason: "鍵つきの行の後に、鍵の無い行がある（作り直された）" };
        }
        // 控えはこの版だけが書き、この版は鍵の無い行を書かない。控えより後の鍵の無い行は、作り直されたもの
        // （切り替えの後の控えを書けなかったときも、切り替えの前の控えで見つける）
        if (firstAnchorSeq !== null && row.seq > firstAnchorSeq) {
          return { ok: false, checked, seq: row.seq, reason: "先頭の控えより後に、鍵の無い行がある（作り直された）" };
        }
        if (!sameText(computeAuditHash(rest), hash)) {
          return { ok: false, checked, seq: row.seq, reason: "行の中身が hash と合わない（書き換えられた）" };
        }
        legacy += 1;
      } else {
        // 鍵の印が替わってよいのは、鍵が替わったことの行だけ（最初の行が鍵つきなら、その行から始まる）
        if (row.keyId !== currentKeyId) {
          const switching = row.action === "audit_key";
          const firstRow = row.seq === 1 && currentKeyId === null;
          if (!switching && !firstRow) {
            return { ok: false, checked, seq: row.seq, reason: "鍵が替わったことの行が無いのに、鍵の印が替わっている（作り直された）" };
          }
          if (retired.has(row.keyId)) {
            return { ok: false, checked, seq: row.seq, reason: `使い終えた鍵（${row.keyId}）に戻っている（作り直された）` };
          }
          // 切り替えは新しい鍵へだけ（設定の順で古い鍵へ戻す行は、鎖にまだ出ていない鍵でも通さない）
          const toRank = keyring.rank.get(row.keyId);
          const fromRank = currentKeyId === null ? -1 : keyring.rank.get(currentKeyId);
          if (toRank !== undefined && fromRank !== undefined && toRank <= fromRank) {
            return { ok: false, checked, seq: row.seq, reason: `前の鍵（${row.keyId}）へ切り替えている（作り直された）` };
          }
        } else if (row.action === "audit_key") {
          return { ok: false, checked, seq: row.seq, reason: "鍵が替わったことの行なのに、鍵の印が前の行と同じ" };
        }
        const key = keyring.byId.get(row.keyId);
        if (!key) {
          return {
            ok: false,
            checked,
            seq: row.seq,
            reason: `この行の鍵（${row.keyId}）が無いので確かめられない（前の SESSION_SECRET で書いた行なら、SESSION_SECRET_PREVIOUS_FILE で前の値を渡す）`,
          };
        }
        if (!sameText(computeAuditMac(rest, key), hash)) {
          return { ok: false, checked, seq: row.seq, reason: "行の中身が hash と合わない（書き換えられた）" };
        }
        // 鍵が替わったことの行は、前の鍵と新しい鍵を detail に書く（hash で守られている）。書いた中身が鎖と合うか
        if (row.keyId !== currentKeyId && row.action === "audit_key") {
          let detail: { from?: unknown; to?: unknown } | null = null;
          try {
            detail = row.detail ? (JSON.parse(row.detail) as { from?: unknown; to?: unknown }) : null;
          } catch {
            detail = null;
          }
          if (detail?.from !== (currentKeyId ?? "sha256") || detail?.to !== row.keyId) {
            return { ok: false, checked, seq: row.seq, reason: "鍵が替わったことの行の、前の鍵と新しい鍵が鎖と合わない" };
          }
        }
        if (row.keyId !== currentKeyId) {
          if (currentKeyId !== null) retired.add(currentKeyId);
          currentKeyId = row.keyId;
        }
      }
      const anchored = anchors.get(row.seq);
      if (anchored !== undefined) {
        if (anchored !== hash) {
          return { ok: false, checked, seq: row.seq, reason: "先頭の控えの hash と合わない（作り直された）" };
        }
        anchorsChecked += 1;
      }
      prevHash = hash;
      expectedSeq += 1;
      checked += 1;
    }
  }
  const configured = !!options.requireAnchors || anchors.size > 0;
  if (configured && anchors.size === 0 && checked > 0) {
    return {
      ok: false,
      checked,
      seq: 1,
      reason: "行があるのに、先頭の控えが無い（控えのファイルが消えたか、別のファイルを見ている）。照らせないので、切り詰めや作り直しを確かめられない",
    };
  }
  let latestSeq: number | null = null;
  for (const seq of anchors.keys()) latestSeq = latestSeq === null ? seq : Math.max(latestSeq, seq);
  if (latestSeq !== null && latestSeq >= expectedSeq) {
    return {
      ok: false,
      checked,
      seq: expectedSeq,
      reason: `先頭の控え（seq ${latestSeq}）より行が少ない（末尾が消された）`,
    };
  }
  const status: AuditAnchorStatus = checked === 0 ? "no-rows" : configured ? "checked" : "not-configured";
  return { ok: true, checked, legacy, anchors: { status, checked: anchorsChecked, latestSeq } };
}
