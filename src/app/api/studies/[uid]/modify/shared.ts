import "server-only";
import { z } from "zod";
import type { Tx } from "@/lib/audit";
import { assertRecentReauth } from "@/lib/auth/local-auth";
import { audit, authContext, type Session } from "@/lib/auth/session";
import { CONTENT_FIELDS, ATTRIBUTE_FIELDS, type CorrectionField } from "@/lib/correction-fields";
import type { Db } from "@/lib/db";
import { isRequestId, isUnresolved, requestOutcome, rowsOfRequest, type RequestRow } from "@/lib/pacs-ops";
import { CorrectionRefused } from "@/lib/study-correction";

// 値の修正の道（./route.ts・./preview・./resolve）が共有する、本文の形・断り方・記録の読み方。

/** 値の1つの欄（形の確かめは correction-fields.ts。ここでは大きさだけを絞る） */
const value = z.string().max(256);
export const Values = z
  .object(Object.fromEntries([...ATTRIBUTE_FIELDS, ...CONTENT_FIELDS].map((f) => [f, value.optional()])) as Record<CorrectionField, z.ZodOptional<z.ZodString>>)
  .strict();

export const Kind = z.enum(["attribute", "content"]);

/** Orthanc の中の検査の ID（同じ UID の検査が複数あるときに選ぶ） */
export const OrthancId = z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{8}){4}$/u, "検査の ID が正しくありません");

/** 結果不明・部分反映の書き換えが残っていて、値の修正を断るときの文言 */
export const UNRESOLVED = "結果不明の修正またはHL7の更新があります。管理者が確認するまで、修正はできません";

/** 大事な操作の前の再認証（AUTH_MODE=local。検証モードはモックだけなので求めない。削除と同じ） */
export async function assertReauth(session: Session) {
  if (!session.local) return;
  assertRecentReauth(await authContext(), session.local.row, session.local.user);
}

/** 断ったことを記録して、画面に文言を返す */
export async function refuse(
  session: Session,
  uid: string,
  requestId: string | null,
  status: number,
  reason: string,
  error: string,
  extra: Record<string, unknown> = {},
  patientId: string | null = null,
): Promise<Response> {
  await audit(session, {
    action: "modify",
    outcome: "denied",
    patientId,
    studyInstanceUid: uid,
    detail: { ...(requestId ? { requestId } : {}), reason, ...extra },
  });
  return Response.json({ error, ...extra }, { status });
}

/** 断る理由を、記録して返す（CorrectionRefused の文言と、画面に要る値：同じ UID の検査の一覧・替え先の患者の値） */
export function refusedBy(session: Session, uid: string, requestId: string | null, e: CorrectionRefused): Promise<Response> {
  return refuse(session, uid, requestId, e.status, e.reason, e.message, e.extra);
}

/**
 * 中身の訂正が、管理者の確かめを待っているか：結果が分からない（「求めた」のまま・結果不明）か、部分反映（作られた検査が
 * 合わない・元が残っていない）のまま、照らし合わせの行（reconcile）が無い
 */
export function contentUnresolved(rows: readonly RequestRow[]): boolean {
  const o = requestOutcome(rows);
  if (o.phase === "none") return false;
  let last: Record<string, unknown> | undefined;
  for (const r of rows) {
    try {
      const d = JSON.parse(r.detail ?? "{}") as Record<string, unknown>;
      // 管理者が書き換えの部品の道（/api/hl7/resolve）で組を解いたときも、解いたとみなす
      if (d.event === "reconcile" && d.manual === true) return false;
      if (d.phase === "result" || d.phase === "reconcile") last = d;
    } catch {
      /* 形の崩れた行は飛ばす */
    }
  }
  if (isUnresolved(o)) return true;
  return last?.phase === "result" && last.partial === true;
}

/**
 * 中身の訂正を、書き換えの部品の組（event group）として残す detail。「求めた」の行に足す。結果・照らし合わせの行には
 * event と writeId を添え、書き換えの部品の unresolved が、結果不明・部分反映のあいだ、HL7 と画面の書き換えを止める
 */
export function contentGroup(writeId: string, requestId: string, orthancId: string, uid: string) {
  return { event: "group", writeId, messageId: requestId, oldOrthancId: orthancId, before: [], after: [], group: [uid], content: true };
}

/**
 * 同じ検査の、管理者の確かめを待っている中身の訂正（結果不明・部分反映）。照らし合わせが済むまで、同じ検査の新しい値の修正を
 * 断るために使う
 */
export async function pendingContent(db: Db | Tx, uid: string): Promise<string[]> {
  return pendingRequests(db, uid, "content", contentUnresolved);
}

/** 同じ検査（URL の UID）の、要求全体の結果がまだ無い・結果不明の属性の訂正（修正の窓を開き直したときに、状態の確認へ戻す） */
export async function pendingAttribute(db: Db | Tx, uid: string): Promise<string[]> {
  return pendingRequests(db, uid, "attribute", (rows) => isUnresolved(requestOutcome(rows)));
}

async function pendingRequests(db: Db | Tx, uid: string, kind: "attribute" | "content", open: (rows: RequestRow[]) => boolean): Promise<string[]> {
  const candidates = await db.auditLog.findMany({
    where: { action: "modify", studyInstanceUid: uid, AND: [{ detail: { contains: `"phase":"request"` } }, { detail: { contains: `"kind":"${kind}"` } }] },
    select: { detail: true },
    orderBy: { seq: "asc" },
  });
  const ids = [...new Set(candidates.map((r) => {
    try {
      return (JSON.parse(r.detail ?? "{}") as { requestId?: unknown }).requestId;
    } catch {
      return undefined;
    }
  }).filter(isRequestId))];
  const out: string[] = [];
  for (const id of ids) {
    if (open(await rowsOfRequest(db, "modify", id, uid))) out.push(id);
  }
  return out;
}

/** 要求の記録の「求めた」の行の detail（無ければ空） */
export function requestDetail(rows: readonly { detail: string | null }[]): Record<string, unknown> {
  for (const r of rows) {
    try {
      const d = JSON.parse(r.detail ?? "{}") as Record<string, unknown>;
      if (d.phase === "request") return d;
    } catch {
      /* 形の崩れた行は飛ばす */
    }
  }
  return {};
}
