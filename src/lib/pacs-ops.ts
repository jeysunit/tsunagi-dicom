import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { RequestError } from "@/lib/api/auth-route";
import type { AuditAction, Tx } from "@/lib/audit";
import { audit, type Session } from "@/lib/auth/session";
import { isJobId } from "@/lib/backend/orthanc-rest";
import type { Backend } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import type { Db } from "@/lib/db";

// PACS の書き込みの操作の共通の部品（docs/spec.md の 3.5「書き込みの操作の共通の決まり」）。
// - 画面が付けた要求の ID（UUID）を、記録の行（求めた・結果・終わり）に入れて結ぶ。
// - 同じ要求の ID の「求めた」の行があれば、Orthanc を呼び直さない（二度押し・送り直しで重ねない）。
//   探すのは、同じ操作の、決めた期間（REQUEST_WINDOW_DAYS）の中の行だけ（索引 action・occurredAt を使う）。
// - 検証モード（AUTH_MODE=dev。モックだけ）では、DEV_ALLOW_WRITE=true のときだけ書き込みの操作を通す。
// - Orthanc の仕事（job）の ID は、BFF が暗号化した token にして画面へ渡す（中身を読ませず、替えさせない。期限つき）。

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isRequestId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

/** 要求の ID を探す期間（日）。これより古い要求の ID は、新しい要求として扱う */
export const REQUEST_WINDOW_DAYS = 7;

/** 同じ要求の ID の記録の行（古い順） */
export async function rowsOfRequest(db: Db | Tx, action: AuditAction, requestId: string, now = new Date()) {
  if (!isRequestId(requestId)) return [];
  return db.auditLog.findMany({
    where: {
      action,
      occurredAt: { gte: new Date(now.getTime() - REQUEST_WINDOW_DAYS * 86_400_000) },
      detail: { contains: `"requestId":"${requestId}"` },
    },
    orderBy: { seq: "asc" },
  });
}

/**
 * 同じ検査の、まだ結果の分からない要求（「求めた」はあるが、結果が unknown か、結果の行がまだ無いもの）。
 * same は、同じ要求とみなす条件（送るなら同じ送り先）。照らし合わせが済むまで、同じ操作の新しい要求を断るために使う
 */
export async function unresolvedRequests(
  db: Db | Tx,
  action: AuditAction,
  studyInstanceUid: string,
  same: (outcome: RequestOutcome) => boolean,
  now = new Date(),
): Promise<string[]> {
  const rows = await db.auditLog.findMany({
    where: { action, studyInstanceUid, occurredAt: { gte: new Date(now.getTime() - REQUEST_WINDOW_DAYS * 86_400_000) } },
    orderBy: { seq: "asc" },
  });
  const byRequest = new Map<string, typeof rows>();
  for (const row of rows) {
    const id = parseDetail(row.detail).requestId;
    if (isRequestId(id)) byRequest.set(id, [...(byRequest.get(id) ?? []), row]);
  }
  const out: string[] = [];
  for (const [id, group] of byRequest) {
    const o = requestOutcome(group);
    if (o.phase === "none" || !same(o)) continue;
    if (o.phase === "requested" || (o.phase === "result" && o.outcome === "unknown")) out.push(id);
  }
  return out;
}

export interface RequestRow {
  actorId: string;
  outcome: string;
  studyInstanceUid?: string | null;
  detail: string | null;
}

export interface RequestOutcome {
  /** none：「求めた」の行が無い（断った行だけのときも none） */
  phase: "none" | "requested" | "result" | "done";
  outcome: string | null;
  jobId: string | null;
  /** 求めた利用者・検査・送り先（最初の「求めた」の行のもの） */
  actorId: string | null;
  studyInstanceUid: string | null;
  modality: string | null;
}

/** 要求の記録の行から、いまの結果を読む（result・done・reconcile の行のうち、いちばん新しいもの） */
export function requestOutcome(rows: readonly RequestRow[]): RequestOutcome {
  const out: RequestOutcome = { phase: "none", outcome: null, jobId: null, actorId: null, studyInstanceUid: null, modality: null };
  for (const row of rows) {
    const d = parseDetail(row.detail);
    if (d.phase === "request") {
      if (out.phase === "none") {
        out.phase = "requested";
        out.actorId = row.actorId;
        out.studyInstanceUid = row.studyInstanceUid ?? null;
        out.modality = typeof d.modality === "string" ? d.modality : null;
      }
    } else if (out.phase !== "none" && (d.phase === "result" || d.phase === "reconcile")) {
      out.phase = out.phase === "done" ? "done" : "result";
      out.outcome = row.outcome;
    } else if (out.phase !== "none" && d.phase === "done") {
      out.phase = "done";
      out.outcome = row.outcome;
    }
    if (out.phase !== "none" && isJobId(d.jobId)) out.jobId = d.jobId;
  }
  return out;
}

function parseDetail(detail: string | null): Record<string, unknown> {
  if (!detail) return {};
  try {
    const v: unknown = JSON.parse(detail);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 検証モードで書き込みが止まっていれば、断ったことを記録して 403（docs/spec.md の 4）。
 * AUTH_MODE=local では、役割の割り当て（requirePermission）だけで決める
 */
export async function assertWriteAllowed(
  session: Session,
  denied: { action: AuditAction; studyInstanceUid?: string | null; detail?: Record<string, unknown> },
): Promise<void> {
  const { auth } = getConfig();
  if (auth.mode !== "dev" || auth.devAllowWrite) return;
  await audit(session, { ...denied, outcome: "denied", detail: { ...(denied.detail ?? {}), reason: "dev_write_blocked" } });
  throw new RequestError(403, "検証モードでは書き込みの操作を止めている（試すときは DEV_ALLOW_WRITE=true）");
}

/**
 * 削除の照らし合わせ：消したはずの検査（「求めた」の行に残した Orthanc の中の ID）が、Orthanc にまだあるか。
 * 古い行で ID が無ければ、同じ UID の検査が1つでもあれば「まだある」
 */
export async function deletedStudyStillPresent(backend: Backend, rows: readonly { detail: string | null }[], uid: string): Promise<boolean> {
  const requestRow = rows.find((r) => parseDetail(r.detail).phase === "request");
  const orthancId = requestRow ? parseDetail(requestRow.detail).orthancId : undefined;
  return typeof orthancId === "string" ? (await backend.studyInfo(orthancId)) !== null : (await backend.lookupStudyIds(uid)).length > 0;
}

/** 形を確かめる前の値を記録に入れるときは、短く切る（記録を大きくさせない） */
export const clip = (value: string, max = 64) => (value.length > max ? `${value.slice(0, max)}…` : value);

// ── 画面へ渡す token（AES-256-GCM。鍵は SESSION_SECRET から HKDF で、用途の名前で分けて導く） ──
// 仕事の ID の token（送る）と、削除の確かめの token（削除）。用途ごとに、頭の字・鍵・AAD を分ける（取り違えて開けない）

const TOKEN_SALT = Buffer.from("tsunagi-dicom", "utf8");
const TOKEN_KINDS = {
  job: { version: "j1", info: "tsunagi-dicom/job-token/v1", aad: Buffer.from("tsunagi-dicom/job-token", "utf8") },
  deleteConfirm: { version: "d1", info: "tsunagi-dicom/delete-confirm/v1", aad: Buffer.from("tsunagi-dicom/delete-confirm", "utf8") },
} as const;
type TokenKind = keyof typeof TOKEN_KINDS;
/** token が使える時間（ミリ秒） */
export const JOB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** 削除の確かめの token が使える時間。確かめの画面を出してから、これより後には消せない（もう一度確かめる） */
export const DELETE_CONFIRM_TTL_MS = 10 * 60 * 1000;

function tokenKey(kind: TokenKind, sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(sessionSecret, "utf8"), TOKEN_SALT, TOKEN_KINDS[kind].info, 32));
}

function sealToken(kind: TokenKind, payload: object, sessionSecret: string, ttlMs: number, now: number): string {
  const { version, aad } = TOKEN_KINDS[kind];
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(kind, sessionSecret), iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp: now + ttlMs }), "utf8"), cipher.final()]);
  return [version, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/** 鍵が違う・書き換えた・期限が過ぎた・用途が違う・形が崩れているときは null */
function openToken(kind: TokenKind, token: string, sessionSecret: string, now: number): Record<string, unknown> | null {
  const { version, aad } = TOKEN_KINDS[kind];
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== version) return null;
  try {
    const [, ivText, bodyText, tagText] = parts as [string, string, string, string];
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(kind, sessionSecret), iv, { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
    const p: unknown = JSON.parse(plain);
    if (!p || typeof p !== "object") return null;
    const o = p as Record<string, unknown>;
    if (typeof o.exp !== "number" || o.exp < now) return null;
    return o;
  } catch {
    return null;
  }
}

/** 削除の確かめの画面で見せた検査（Orthanc の中の ID・UID・患者 ID・版）と、見せた利用者。消す直前まで、全部が合うときだけ消す */
export interface DeleteConfirmPayload {
  orthancId: string;
  studyInstanceUid: string;
  patientId: string;
  version: string;
  actorId: string;
}

export function signDeleteConfirm(payload: DeleteConfirmPayload, sessionSecret: string, now = Date.now()): string {
  return sealToken("deleteConfirm", payload, sessionSecret, DELETE_CONFIRM_TTL_MS, now);
}

export function openDeleteConfirm(token: string, sessionSecret: string, now = Date.now()): DeleteConfirmPayload | null {
  const p = openToken("deleteConfirm", token, sessionSecret, now);
  if (!p) return null;
  const { orthancId, studyInstanceUid, patientId, version, actorId } = p;
  if (![orthancId, studyInstanceUid, patientId, version, actorId].every((v) => typeof v === "string")) return null;
  return { orthancId, studyInstanceUid, patientId, version, actorId } as DeleteConfirmPayload;
}

export interface JobTokenPayload {
  jobId: string;
  requestId: string;
  studyInstanceUid: string;
  modality: string;
  /** 送った利用者（ほかの利用者の仕事は読ませない） */
  actorId: string;
}

export function signJobToken(payload: JobTokenPayload, sessionSecret: string, now = Date.now()): string {
  return sealToken("job", payload, sessionSecret, JOB_TOKEN_TTL_MS, now);
}

/** 鍵が違う・書き換えた・期限が過ぎた・形が崩れているときは null */
export function openJobToken(token: string, sessionSecret: string, now = Date.now()): JobTokenPayload | null {
  const p = openToken("job", token, sessionSecret, now);
  if (!p) return null;
  if (!isJobId(p.jobId) || !isRequestId(p.requestId) || typeof p.studyInstanceUid !== "string") return null;
  if (typeof p.modality !== "string" || typeof p.actorId !== "string") return null;
  return { jobId: p.jobId, requestId: p.requestId, studyInstanceUid: p.studyInstanceUid, modality: p.modality, actorId: p.actorId };
}
