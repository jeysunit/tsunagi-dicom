import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { RequestError } from "@/lib/api/auth-route";
import type { AuditAction, Tx } from "@/lib/audit";
import { audit, type Session } from "@/lib/auth/session";
import { isJobId } from "@/lib/backend/orthanc-rest";
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

/** 形を確かめる前の値を記録に入れるときは、短く切る（記録を大きくさせない） */
export const clip = (value: string, max = 64) => (value.length > max ? `${value.slice(0, max)}…` : value);

// ── 仕事の ID の token（AES-256-GCM。鍵は SESSION_SECRET から HKDF で、用途の名前で分けて導く） ──

const TOKEN_VERSION = "j1";
const TOKEN_INFO = "tsunagi-dicom/job-token/v1";
const TOKEN_SALT = Buffer.from("tsunagi-dicom", "utf8");
const TOKEN_AAD = Buffer.from("tsunagi-dicom/job-token", "utf8");
/** token が使える時間（ミリ秒） */
export const JOB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function tokenKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(sessionSecret, "utf8"), TOKEN_SALT, TOKEN_INFO, 32));
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
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(sessionSecret), iv, { authTagLength: 16 });
  cipher.setAAD(TOKEN_AAD);
  const body = Buffer.concat([cipher.update(JSON.stringify({ ...payload, exp: now + JOB_TOKEN_TTL_MS }), "utf8"), cipher.final()]);
  return [TOKEN_VERSION, iv.toString("base64url"), body.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

/** 鍵が違う・書き換えた・期限が過ぎた・形が崩れているときは null */
export function openJobToken(token: string, sessionSecret: string, now = Date.now()): JobTokenPayload | null {
  if (token.length > 2048) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;
  try {
    const [, ivText, bodyText, tagText] = parts as [string, string, string, string];
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", tokenKey(sessionSecret), iv, { authTagLength: 16 });
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(bodyText, "base64url")), decipher.final()]).toString("utf8");
    const p = JSON.parse(plain) as Partial<JobTokenPayload> & { exp?: unknown };
    if (typeof p.exp !== "number" || p.exp < now) return null;
    if (!isJobId(p.jobId) || !isRequestId(p.requestId) || typeof p.studyInstanceUid !== "string") return null;
    if (typeof p.modality !== "string" || typeof p.actorId !== "string") return null;
    return { jobId: p.jobId, requestId: p.requestId, studyInstanceUid: p.studyInstanceUid, modality: p.modality, actorId: p.actorId };
  } catch {
    return null;
  }
}
