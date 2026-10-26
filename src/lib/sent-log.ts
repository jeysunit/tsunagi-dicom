import "server-only";
import { RequestError } from "@/lib/api/auth-route";
import type { Role } from "@/lib/auth/roles";
import { auditIf, type Session } from "@/lib/auth/session";
import { studyFromDicomJson } from "@/lib/backend/dicom-json";
import { isJobId } from "@/lib/backend/orthanc-rest";
import type { Backend, JobState } from "@/lib/backend/types";
import type { Db } from "@/lib/db";
import {
  allowlistFor,
  sentView,
  studyRecord,
  type FieldAllowlistMap,
  type SentRecord,
  type SentStatus,
  type SentView,
  type StudyRecord,
} from "@/lib/fields";
import { isRequestId, requestOutcome, rowsOfRequest } from "@/lib/pacs-ops";
import { todayIn } from "@/lib/study-filter";

// 送信一覧（docs/spec.md の 3.4）。tsunagi-dicom が求めた送信を、期間で読んで新しい順に並べる。読むだけの画面。
// - 読む元は BFF の監査の記録の送信の行（求めた・結果・終わり・照らした。要求の ID で結ぶ）と、Orthanc の仕事（/jobs/{id}）。
//   BFF に送信の表を別に持たない（原則 10。正本は監査の記録と Orthanc）。
// - 検査の項目（氏名・モダリティ・検査名・画像数など）は、いまの Orthanc から読む。もう無い検査は、監査の記録にある
//   患者 ID と StudyInstanceUID だけを出す。どちらも役割の許可の一覧（sent・study）で絞る（原則 8）。
// - 期間の中の送信が上限（1,000 件）を超えたら、新しい 1,000 件だけを返し、超えたことを返す。
// - 仕事の終わり（成功・失敗）を初めて読んだときは、送った仕事の状態の道（/api/jobs/{token}）と同じく、記録（send の done）に
//   1行だけ足す（3.4「仕事の終わりは、BFF が初めて終わりを読んだときに記録する」）。Orthanc へは書かない。

/** 期間の中で読む送信の上限（docs/design-system/components.md の「送受信の一覧」） */
export const SENT_LIMIT = 1000;

/** 求めた後に結果の行が無い送信を、送信待ちとみなす間（Orthanc を呼んでいる途中）。過ぎたら結果不明 */
export const SENT_REQUEST_GRACE_MS = 2 * 60_000;

/** Orthanc を同時に読む数（検査と仕事） */
const CONCURRENCY = 8;

export const SENT_PERIODS = ["today", "yesterday", "week", "range"] as const;
export type SentPeriod = (typeof SENT_PERIODS)[number];

export interface SentRange {
  period: SentPeriod;
  /** 時間帯（TZ）の日付（yyyy-MM-dd）。両端を含む */
  fromDate: string;
  toDate: string;
  /** 読む範囲（UTC の時刻。from を含み、to を含まない） */
  from: Date;
  to: Date;
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLocalDate(value: string | null): LocalDate | null {
  const m = DATE_TEXT.exec(value ?? "");
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(year, month - 1, day));
  if (t.getUTCFullYear() !== year || t.getUTCMonth() !== month - 1 || t.getUTCDate() !== day) return null;
  return { year, month, day };
}

function addDays(d: LocalDate, days: number): LocalDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

const dateText = (d: LocalDate) => `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
const before = (a: LocalDate, b: LocalDate) => Date.UTC(a.year, a.month - 1, a.day) < Date.UTC(b.year, b.month - 1, b.day);

/** 時間帯 timeZone の、時刻 t の UTC からのずれ（ミリ秒） */
function offsetAt(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, Number(p.value)]),
  ) as Record<string, number>;
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(t / 1000) * 1000;
}

/** 時間帯 timeZone の、その日の 0 時（UTC の時刻） */
export function startOfDayIn(d: LocalDate, timeZone: string): Date {
  const guess = Date.UTC(d.year, d.month - 1, d.day);
  const first = offsetAt(guess, timeZone);
  const t = guess - first;
  const second = offsetAt(t, timeZone);
  return new Date(second === first ? t : guess - second);
}

/**
 * 画面の条件（period と、期間を指定するときの from・to〔yyyy-MM-dd〕）から、読む範囲を決める。日付は時間帯（TZ）の日付。
 * 過去7日は今日を含む7日。形の合わない条件は 400
 */
export function sentRange(params: URLSearchParams, timeZone: string, now = new Date()): SentRange {
  const raw = params.get("period") ?? "today";
  if (!(SENT_PERIODS as readonly string[]).includes(raw)) throw new RequestError(400, "期間は 今日・昨日・過去7日・期間を指定 から選んでください");
  const period = raw as SentPeriod;
  const today = todayIn(timeZone, now);
  let first: LocalDate;
  let last: LocalDate;
  if (period === "today") [first, last] = [today, today];
  else if (period === "yesterday") [first, last] = [addDays(today, -1), addDays(today, -1)];
  else if (period === "week") [first, last] = [addDays(today, -6), today];
  else {
    const from = parseLocalDate(params.get("from"));
    const to = parseLocalDate(params.get("to"));
    if (!from || !to) throw new RequestError(400, "期間の開始日と終了日を入力してください");
    if (before(to, from)) throw new RequestError(400, "終了日は開始日と同じ日か、後の日にしてください");
    [first, last] = [from, to];
  }
  return {
    period,
    fromDate: dateText(first),
    toDate: dateText(last),
    from: startOfDayIn(first, timeZone),
    to: startOfDayIn(addDays(last, 1), timeZone),
  };
}

interface AuditRow {
  seq: number;
  occurredAt: Date;
  actorId: string;
  outcome: string;
  patientId: string | null;
  studyInstanceUid: string | null;
  detail: string | null;
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

/** 記録の行から読んだ、1つの送信のいまの段 */
export type SentStage =
  | { kind: "final"; status: SentStatus; finishedAt: Date | null }
  /** Orthanc が仕事を受けた。仕事の状態を読んで決める */
  | { kind: "job"; jobId: string };

/**
 * 1つの送信の記録の行（古い順。「求めた」の行を含む）から、いまの段を読む。
 * 結果・照らした・終わりの行のうち、いちばん新しいものを使う（docs/spec.md の 3.5）
 */
export function sentStage(rows: readonly AuditRow[], now: Date): SentStage {
  const request = rows.find((r) => parseDetail(r.detail).phase === "request");
  let latest: { phase: string; row: AuditRow; jobId: string | null } | null = null;
  for (const row of rows) {
    const d = parseDetail(row.detail);
    if (d.phase === "result" || d.phase === "reconcile" || d.phase === "done") {
      latest = { phase: d.phase, row, jobId: isJobId(d.jobId) ? d.jobId : null };
    }
  }
  if (!latest) {
    // 求めた後、結果の行がまだ無い：Orthanc を呼んでいる途中なら送信待ち。時間が過ぎていれば、答えを残せなかった結果不明
    const age = request ? now.getTime() - request.occurredAt.getTime() : Number.POSITIVE_INFINITY;
    return { kind: "final", status: age < SENT_REQUEST_GRACE_MS ? "pending" : "unknown", finishedAt: null };
  }
  const { phase, row, jobId } = latest;
  if (phase === "done" || phase === "reconcile") {
    const status: SentStatus = row.outcome === "success" ? "sent" : row.outcome === "failed" ? "failed" : "unknown";
    return { kind: "final", status, finishedAt: status === "unknown" ? null : row.occurredAt };
  }
  // 呼んだ後の結果
  if (row.outcome === "failed") return { kind: "final", status: "failed", finishedAt: row.occurredAt };
  if (row.outcome === "success" && jobId) return { kind: "job", jobId };
  return { kind: "final", status: "unknown", finishedAt: null };
}

/** Orthanc の仕事の状態を、画面の送信の状態にする。仕事が Orthanc の履歴から消えていれば（null）結果不明 */
export function jobSentStatus(state: JobState | null): SentStatus {
  switch (state) {
    case "Pending":
    case "Paused":
    case "Retry":
      return "pending";
    case "Running":
      return "running";
    case "Success":
      return "sent";
    case "Failure":
      return "failed";
    default:
      return "unknown";
  }
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 「求めた」の行と、その中身（要求の ID と検査の UID を確かめたもの） */
interface RequestEntry {
  row: AuditRow & { studyInstanceUid: string };
  detail: Record<string, unknown>;
  requestId: string;
  uid: string;
}

export interface SentLog {
  items: SentView[];
  /** 返した送信の患者 ID と StudyInstanceUID（監査の記録の returned に入れる。画面へは返さない） */
  returned: { patientId: string; studyInstanceUid: string }[];
  /** 期間の中の送信が上限を超え、新しい上限の数だけを返した */
  truncated: boolean;
}

export interface SentLogDeps {
  db: Db;
  backend: Pick<Backend, "studyDataset" | "jobStatus">;
  /** 仕事の終わりを初めて読んだときに記録する利用者 */
  session: Session;
  role: Role;
  allowlists?: FieldAllowlistMap;
  now?: Date;
}

/** 期間の中の送信を、新しい順に、役割の許可の一覧で絞って返す */
export async function sentLogView(deps: SentLogDeps, range: SentRange): Promise<SentLog> {
  const { db, backend, session } = deps;
  const now = deps.now ?? new Date();
  const allowlist = allowlistFor(deps.role, deps.allowlists);

  // 「求めた」の行（断った行は phase を持たないので入らない）。新しい順に、上限より 1 件多く読んで、超えたかを知る
  const requestRows = await db.auditLog.findMany({
    where: { action: "send", occurredAt: { gte: range.from, lt: range.to }, detail: { contains: `"phase":"request"` } },
    orderBy: { seq: "desc" },
    take: SENT_LIMIT + 1,
  });
  const truncated = requestRows.length > SENT_LIMIT;
  const requests: RequestEntry[] = [];
  for (const row of requestRows.slice(0, SENT_LIMIT)) {
    const detail = parseDetail(row.detail);
    if (!isRequestId(detail.requestId) || !row.studyInstanceUid) continue;
    requests.push({ row: { ...row, studyInstanceUid: row.studyInstanceUid }, detail, requestId: detail.requestId, uid: row.studyInstanceUid });
  }
  if (requests.length === 0) return { items: [], returned: [], truncated };

  // 同じ検査の、いちばん古い「求めた」より後の送信の行を、まとめて読んで要求の ID で分ける
  const uids = [...new Set(requests.map((r) => r.uid))];
  const minSeq = Math.min(...requests.map((r) => r.row.seq));
  const later = await db.auditLog.findMany({
    where: { action: "send", seq: { gte: minSeq }, studyInstanceUid: { in: uids } },
    orderBy: { seq: "asc" },
  });
  const byRequest = new Map<string, AuditRow[]>();
  for (const row of later) {
    const id = parseDetail(row.detail).requestId;
    if (typeof id !== "string") continue;
    const list = byRequest.get(id) ?? [];
    list.push(row);
    byRequest.set(id, list);
  }

  // 送信ごとの状態。仕事を読む必要があるものだけ、Orthanc を読む
  const staged = requests.map((r) => {
    const rows = (byRequest.get(r.requestId) ?? [r.row]).filter((x) => x.studyInstanceUid === r.uid);
    return { ...r, stage: sentStage(rows, now) };
  });
  const statuses = await mapLimit(staged, CONCURRENCY, async (r): Promise<{ status: SentStatus; finishedAt: Date | null }> => {
    if (r.stage.kind === "final") return { status: r.stage.status, finishedAt: r.stage.finishedAt };
    // 仕事を読めない（Orthanc の通信の失敗・拒否）ときは、一覧全体の誤りにせず、その行だけ結果不明にする
    const job = await backend.jobStatus(r.stage.jobId).catch(() => null);
    const status = jobSentStatus(job?.state ?? null);
    if (job && (job.state === "Success" || job.state === "Failure")) {
      return { status, finishedAt: await recordDone(session, r, job.id, job.state, job.errorCode) };
    }
    return { status, finishedAt: null };
  });

  // 検査の項目は、いまの Orthanc から（同じ検査は1回だけ読む）
  const studies = new Map<string, StudyRecord | null>();
  await mapLimit(uids, CONCURRENCY, async (uid) => {
    const dataset = await backend.studyDataset(uid);
    studies.set(uid, dataset ? studyRecord(studyFromDicomJson(dataset)) : null);
  });

  const items: SentView[] = [];
  const returned: SentLog["returned"] = [];
  staged.forEach((r, i) => {
    const { status, finishedAt } = statuses[i]!;
    const uid = r.uid;
    const found = studies.get(uid) ?? null;
    // もう Orthanc に無い検査は、監査の記録の患者 ID と StudyInstanceUID だけ（ほかの項目は監査の記録に無い）
    const study = found ?? { patientId: r.row.patientId ?? "", studyInstanceUid: uid };
    const record: SentRecord = {
      requestId: r.requestId,
      requestedAt: r.row.occurredAt.toISOString(),
      finishedAt: finishedAt ? finishedAt.toISOString() : null,
      destination: typeof r.detail.modality === "string" ? r.detail.modality : "",
      destinationAet: typeof r.detail.aet === "string" ? r.detail.aet : null,
      status,
    };
    items.push(sentView(record, study, allowlist));
    returned.push({ patientId: study.patientId, studyInstanceUid: uid });
  });
  return { items, returned, truncated };
}

/**
 * 仕事の終わり（成功・失敗）を、まだ記録に無ければ1行だけ足す（/api/jobs/{token} と同じ形。記録の並びの中で確かめる）。
 * 足した行か、先にあった終わりの行の時刻を返す
 */
async function recordDone(
  session: Session,
  { detail, row: request, requestId, uid }: RequestEntry,
  jobId: string,
  state: "Success" | "Failure",
  errorCode: number,
): Promise<Date> {
  return auditIf<Date>(session, async (tx) => {
    const rows = await rowsOfRequest(tx, "send", requestId, uid);
    if (requestOutcome(rows).phase === "done") {
      const done = rows.filter((r) => parseDetail(r.detail).phase === "done").at(-1);
      return { value: done?.occurredAt ?? new Date(), fields: null };
    }
    return {
      value: new Date(),
      fields: {
        action: "send",
        outcome: state === "Success" ? "success" : "failed",
        studyInstanceUid: uid,
        patientId: request.patientId,
        detail: {
          phase: "done",
          via: "send_log",
          requestId,
          modality: detail.modality,
          jobId,
          state,
          ...(state === "Failure" ? { errorCode } : {}),
        },
      },
    };
  });
}
