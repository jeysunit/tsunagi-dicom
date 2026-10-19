import { BackendError, type JobState, type JobStatus, type ModalityEntry, type OrthancStudyInfo, type StudySummary } from "@/lib/backend/types";

// Orthanc の REST の応答の読み取り（docs/spec.md の 3.3・3.4）。実の Orthanc（http.ts）とモック（mock.ts）で同じものを使う。
// 形は Orthanc Book（REST API の「Tracking changes」「Sending resources to remote modalities」「Performing C-Echo」、
// 「Advanced features of the REST API」の Jobs）に合わせた。応答の値はそのまま信じず、形を確かめてから使う。

/** Orthanc の中の ID（SHA-1 を 8 字ずつ 5 つに分けたもの） */
const ORTHANC_ID = /^[0-9a-f]{8}(-[0-9a-f]{8}){4}$/;
export const isOrthancId = (v: unknown): v is string => typeof v === "string" && ORTHANC_ID.test(v);

/** Orthanc に登録した機器の名前（Orthanc の中の ID）。URL の段に入れるので、字を絞る */
const MODALITY_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const isModalityName = (v: unknown): v is string => typeof v === "string" && MODALITY_NAME.test(v);

/** Orthanc の仕事（job）の ID（UUID） */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isJobId = (v: unknown): v is string => typeof v === "string" && JOB_ID.test(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** 変更の記録（`/changes`）の1つ */
export interface OrthancChange {
  seq: number;
  changeType: string;
  resourceType: string;
  id: string;
  /** Orthanc の時刻（`20130507T143902`） */
  date: string;
}

export interface OrthancChanges {
  changes: OrthancChange[];
  last: number;
  done: boolean;
}

export function parseChanges(json: unknown): OrthancChanges {
  const o = obj(json);
  const list = Array.isArray(o.Changes) ? o.Changes : [];
  const changes = list.flatMap((c): OrthancChange[] => {
    const x = obj(c);
    return typeof x.Seq === "number" && isOrthancId(x.ID)
      ? [{ seq: x.Seq, changeType: str(x.ChangeType), resourceType: str(x.ResourceType), id: x.ID, date: str(x.Date) }]
      : [];
  });
  return { changes, last: typeof o.Last === "number" ? o.Last : 0, done: o.Done === true };
}

/**
 * 変更の記録を、Orthanc Book の追い方（since・limit・Last・Done）どおりに読む：`from` の番号の後から、
 * 答えの Last を次の since にして、Done になるまで読み切る。Orthanc が 1 回に返す数を切り詰めても、区間の中は抜けない。
 * 読む回数が上限（maxCalls）に届いたら、そこで止めて complete=false を返す
 */
export async function readChanges(
  fetchPage: (since: number, limit: number) => Promise<OrthancChanges>,
  from: number,
  options: { limit: number; maxCalls: number },
): Promise<{ changes: OrthancChange[]; complete: boolean }> {
  const changes: OrthancChange[] = [];
  let since = from;
  for (let call = 0; call < options.maxCalls; call++) {
    const page = await fetchPage(since, options.limit);
    changes.push(...page.changes.filter((c) => c.seq > since));
    if (page.done || page.changes.length === 0 || page.last <= since) return { changes, complete: true };
    since = page.last;
  }
  return { changes, complete: false };
}

/** 受け取った検査（新しい順）。検査の新しい・落ち着いたの出来事のうち、いちばん新しい時刻を受け取った時刻にする */
export function receivedStudyIds(changes: readonly OrthancChange[], limit: number): { id: string; date: string }[] {
  const latest = new Map<string, { date: string; seq: number }>();
  for (const c of changes) {
    if (c.resourceType !== "Study" || (c.changeType !== "NewStudy" && c.changeType !== "StableStudy")) continue;
    const prev = latest.get(c.id);
    if (!prev || prev.seq < c.seq) latest.set(c.id, { date: c.date, seq: c.seq });
  }
  return [...latest.entries()]
    .sort((a, b) => b[1].seq - a[1].seq)
    .slice(0, Math.max(0, limit))
    .map(([id, v]) => ({ id, date: v.date }));
}

/** Orthanc の時刻（`YYYYMMDDTHHMMSS`）を ISO 8601 の形（時間帯なし）にする。読めなければ空 */
export function orthancTime(value: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(value);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : "";
}

/** `/studies/{id}` と、その検査のシリーズ（`/studies/{id}/series`）から、検査の要約と画像の数を作る */
export function studyFromRest(study: unknown, series: readonly unknown[]): { summary: StudySummary; instanceCount: number } {
  const s = obj(study);
  const main = obj(s.MainDicomTags);
  const patient = obj(s.PatientMainDicomTags);
  const rows = series.map(obj);
  const modalities = [...new Set(rows.map((r) => str(obj(r.MainDicomTags).Modality)).filter(Boolean))];
  const instanceCount = rows.reduce((n, r) => n + (Array.isArray(r.Instances) ? r.Instances.length : 0), 0);
  return {
    summary: {
      studyInstanceUid: str(main.StudyInstanceUID),
      patientId: str(patient.PatientID),
      patientName: str(patient.PatientName),
      patientBirthDate: str(patient.PatientBirthDate),
      patientSex: str(patient.PatientSex),
      studyDate: str(main.StudyDate),
      studyTime: str(main.StudyTime),
      accessionNumber: str(main.AccessionNumber),
      studyDescription: str(main.StudyDescription),
      studyId: str(main.StudyID),
      referringPhysicianName: str(main.ReferringPhysicianName),
      modalities,
      seriesCount: rows.length,
      instanceCount,
    },
    instanceCount,
  };
}

/** シリーズの並びから、最初の画像の ID（受け取りのメタデータを読む先） */
export function firstInstanceId(series: readonly unknown[]): string | null {
  for (const r of series.map(obj)) {
    const first = Array.isArray(r.Instances) ? r.Instances.find(isOrthancId) : undefined;
    if (first) return first;
  }
  return null;
}

/** 画像のメタデータ（`/instances/{id}/metadata?expand`）のうち、受け取りに使う値 */
export function receptionFromMetadata(json: unknown): { remoteAet: string | null; origin: string | null } {
  const m = obj(json);
  const remoteAet = str(m.RemoteAET) || str(m.RemoteAet);
  return { remoteAet: remoteAet || null, origin: str(m.Origin) || null };
}

/** 登録した機器（`/modalities?expand`）。名前の順 */
export function modalitiesFromRest(json: unknown): ModalityEntry[] {
  return Object.entries(obj(json))
    .filter(([id]) => isModalityName(id))
    .map(([id, v]): ModalityEntry => {
      const m = obj(v);
      return {
        id,
        aet: str(m.AET),
        host: str(m.Host),
        port: typeof m.Port === "number" ? m.Port : null,
        manufacturer: str(m.Manufacturer),
        allowEcho: typeof m.AllowEcho === "boolean" ? m.AllowEcho : null,
        allowStore: typeof m.AllowStore === "boolean" ? m.AllowStore : null,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

const JOB_STATES: readonly JobState[] = ["Pending", "Running", "Success", "Failure", "Paused", "Retry"];

/** 仕事の状態（`/jobs/{id}`）。返すのは状態・進み・誤り・時刻だけ（中身の Content は返さない） */
export function jobFromRest(json: unknown): JobStatus | null {
  const j = obj(json);
  if (!isJobId(j.ID) || !JOB_STATES.includes(j.State as JobState)) return null;
  return {
    id: j.ID,
    state: j.State as JobState,
    progress: typeof j.Progress === "number" ? Math.max(0, Math.min(100, j.Progress)) : 0,
    errorCode: typeof j.ErrorCode === "number" ? j.ErrorCode : 0,
    errorDescription: str(j.ErrorDescription),
    creationTime: orthancTime(str(j.CreationTime)),
    completionTime: orthancTime(str(j.CompletionTime)) || null,
  };
}

/** /tools/lookup の答えのうち、検査（Type が Study）の ID の全部 */
export function studyIdsFromLookup(json: unknown): string[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((r) => {
    const x = obj(r);
    return x.Type === "Study" && isOrthancId(x.ID) ? [x.ID] : [];
  });
}

/** 引き当ての答えがちょうど1件ならその ID、無ければ null、2件以上なら選ばずに 409（取り違えて書かない） */
export function singleStudyId(ids: readonly string[]): string | null {
  if (ids.length === 0) return null;
  if (ids.length > 1) throw new BackendError("同じ StudyInstanceUID の検査が Orthanc に2つ以上ある（患者違いなど）。どれかを選んで書かない", 409);
  return ids[0]!;
}

/** /studies/{id} から、消す前の確かめに使う要点と版（LastUpdate） */
export function studyInfoFromRest(json: unknown): OrthancStudyInfo | null {
  const s = obj(json);
  if (!isOrthancId(s.ID)) return null;
  const main = obj(s.MainDicomTags);
  const patient = obj(s.PatientMainDicomTags);
  return {
    orthancId: s.ID,
    studyInstanceUid: str(main.StudyInstanceUID),
    patientId: str(patient.PatientID),
    patientName: str(patient.PatientName),
    studyDate: str(main.StudyDate),
    seriesCount: Array.isArray(s.Series) ? s.Series.length : 0,
    version: str(s.LastUpdate),
  };
}

/** 仕事が終わったか（成功か失敗） */
export const jobFinished = (state: JobState) => state === "Success" || state === "Failure";
