import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/db";

// 監査の記録（docs/spec.md の 3.6「監査の記録」、第7.0版 17 遵守事項①②）。
// 誰が・いつ・どの患者と検査に・何をしたを、追記だけで残す。
// 各行は前の行の hash を prevHash に持ち、行の中身と prevHash の SHA-256 を hash にする。
// 書き換え・途中の削除・差し込みは verifyAuditChain で見つかる。
// このモジュールには追記と確かめだけを置き、更新・削除の関数は作らない。

export const AUDIT_ACTIONS = [
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
  // 利用者の管理（段 1b）：作る・止める／戻す・役割の変更
  "user_create",
  "user_status_change",
  "role_change",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
/** success：通した。denied：このアプリが断った。failed：画像サーバーが失敗を返した・つながらなかった */
export type AuditOutcome = "success" | "denied" | "failed";

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
}

/** hash の元にする行。後から足した項目は、無い（null の）行では省ける */
export type AuditHashInput = Omit<AuditRow, "hash" | "sourceAddressUnverified"> &
  Partial<Pick<AuditRow, "sourceAddressUnverified">>;

/**
 * hash の元にする並び。項目を足すときは末尾に足し、古い行の確かめ方を変えない：
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

// 1つのプロセスの中で追記を一列に並べる（前の行の hash を読んでから書くため）。
// ほかのプロセスと競ったときは prevHash の一意の制約で失敗し、つなぎは枝分かれしない。
let queue: Promise<unknown> = Promise.resolve();

export function appendAudit(db: Db, input: AuditEntryInput): Promise<AuditRow> {
  const run = queue.then(() =>
    db.$transaction(async (tx) => {
      const last = await tx.auditLog.findFirst({ orderBy: { seq: "desc" } });
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
      };
      return tx.auditLog.create({ data: { ...base, hash: computeAuditHash(base) } });
    }),
  );
  queue = run.catch(() => undefined);
  return run;
}

export type AuditChainResult =
  | { ok: true; checked: number }
  | { ok: false; checked: number; seq: number; reason: string };

/**
 * つなぎを頭から確かめる。最初に見つかった食い違いを返す。
 * 末尾の行を消されたときは、残りのつなぎが正しいので見つからない（件数を別に控えて比べる）。
 */
export async function verifyAuditChain(db: Db, batchSize = 1000): Promise<AuditChainResult> {
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  let checked = 0;
  for (;;) {
    const rows = await db.auditLog.findMany({
      where: { seq: { gte: expectedSeq } },
      orderBy: { seq: "asc" },
      take: batchSize,
    });
    if (rows.length === 0) return { ok: true, checked };
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, checked, seq: expectedSeq, reason: `seq ${expectedSeq} の行が無い（消された）` };
      }
      if (row.prevHash !== prevHash) {
        return { ok: false, checked, seq: row.seq, reason: "prevHash が前の行の hash と合わない" };
      }
      const { hash, ...rest } = row;
      if (computeAuditHash(rest) !== hash) {
        return { ok: false, checked, seq: row.seq, reason: "行の中身が hash と合わない（書き換えられた）" };
      }
      prevHash = hash;
      expectedSeq += 1;
      checked += 1;
    }
  }
}
