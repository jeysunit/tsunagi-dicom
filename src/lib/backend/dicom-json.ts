import type { InstanceSummary, SeriesSummary, StudyQuery, StudySummary } from "@/lib/backend/types";

// DICOM JSON（PS3.18 F.2）の読み取り。QIDO-RS の応答を StudySummary にする。

type DicomJsonValue =
  | string
  | number
  | { Alphabetic?: string; Ideographic?: string; Phonetic?: string }
  | DicomJsonDataset;
export type DicomJsonDataset = Record<
  string,
  { vr: string; Value?: DicomJsonValue[]; InlineBinary?: string; BulkDataURI?: string } | undefined
>;

export const TAG = {
  StudyDate: "00080020",
  SeriesDate: "00080021",
  Modality: "00080060",
  ReferringPhysicianName: "00080090",
  SeriesDescription: "0008103E",
  BodyPartExamined: "00180015",
  SeriesInstanceUID: "0020000E",
  StudyID: "00200010",
  SeriesNumber: "00200011",
  NumberOfSeriesRelatedInstances: "00201209",
  StudyTime: "00080030",
  AccessionNumber: "00080050",
  ModalitiesInStudy: "00080061",
  StudyDescription: "00081030",
  PatientName: "00100010",
  PatientID: "00100020",
  PatientBirthDate: "00100030",
  PatientSex: "00100040",
  StudyInstanceUID: "0020000D",
  NumberOfStudyRelatedSeries: "00201206",
  NumberOfStudyRelatedInstances: "00201208",
  SOPClassUID: "00080016",
  SOPInstanceUID: "00080018",
  InstanceNumber: "00200013",
  NumberOfFrames: "00280008",
} as const;

function values(ds: DicomJsonDataset, tag: string): DicomJsonValue[] {
  return ds[tag]?.Value ?? [];
}

export function stringValue(ds: DicomJsonDataset, tag: string): string {
  const v = values(ds, tag)[0];
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return isPersonName(v) ? personNameToString(v) : "";
  return String(v);
}

function isPersonName(v: object): v is { Alphabetic?: string; Ideographic?: string; Phonetic?: string } {
  return Object.keys(v).every((k) => k === "Alphabetic" || k === "Ideographic" || k === "Phonetic");
}

/** PN の3つの組を、DICOM の文字列の形（Alphabetic=Ideographic=Phonetic）に戻す。末尾の空の組は落とす */
export function personNameToString(pn: { Alphabetic?: string; Ideographic?: string; Phonetic?: string }): string {
  const parts = [pn.Alphabetic ?? "", pn.Ideographic ?? "", pn.Phonetic ?? ""];
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.join("=");
}

function numberValue(ds: DicomJsonDataset, tag: string): number | null {
  const v = values(ds, tag)[0];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function studyFromDicomJson(ds: DicomJsonDataset): StudySummary {
  return {
    studyInstanceUid: stringValue(ds, TAG.StudyInstanceUID),
    patientId: stringValue(ds, TAG.PatientID),
    patientName: stringValue(ds, TAG.PatientName),
    patientBirthDate: stringValue(ds, TAG.PatientBirthDate),
    patientSex: stringValue(ds, TAG.PatientSex),
    studyDate: stringValue(ds, TAG.StudyDate),
    studyTime: stringValue(ds, TAG.StudyTime),
    accessionNumber: stringValue(ds, TAG.AccessionNumber),
    studyDescription: stringValue(ds, TAG.StudyDescription),
    studyId: stringValue(ds, TAG.StudyID),
    referringPhysicianName: stringValue(ds, TAG.ReferringPhysicianName),
    modalities: values(ds, TAG.ModalitiesInStudy).map(String),
    seriesCount: numberValue(ds, TAG.NumberOfStudyRelatedSeries),
    instanceCount: numberValue(ds, TAG.NumberOfStudyRelatedInstances),
  };
}

export function seriesFromDicomJson(ds: DicomJsonDataset): SeriesSummary {
  return {
    seriesInstanceUid: stringValue(ds, TAG.SeriesInstanceUID),
    modality: stringValue(ds, TAG.Modality),
    seriesNumber: stringValue(ds, TAG.SeriesNumber),
    seriesDescription: stringValue(ds, TAG.SeriesDescription),
    bodyPartExamined: stringValue(ds, TAG.BodyPartExamined),
    seriesDate: stringValue(ds, TAG.SeriesDate),
    instanceCount: numberValue(ds, TAG.NumberOfSeriesRelatedInstances),
  };
}

/** シリーズの番号の順（番号が無い・数でないものは後ろ。同じなら SeriesInstanceUID の順） */
export function sortSeries(series: SeriesSummary[]): SeriesSummary[] {
  const num = (s: SeriesSummary) => (/^-?\d+$/.test(s.seriesNumber.trim()) ? Number(s.seriesNumber) : Number.POSITIVE_INFINITY);
  return [...series].sort((a, b) => num(a) - num(b) || a.seriesInstanceUid.localeCompare(b.seriesInstanceUid));
}

export function instanceFromDicomJson(ds: DicomJsonDataset): InstanceSummary {
  return {
    studyInstanceUid: stringValue(ds, TAG.StudyInstanceUID),
    seriesInstanceUid: stringValue(ds, TAG.SeriesInstanceUID),
    patientId: stringValue(ds, TAG.PatientID),
    sopInstanceUid: stringValue(ds, TAG.SOPInstanceUID),
    sopClassUid: stringValue(ds, TAG.SOPClassUID),
    instanceNumber: stringValue(ds, TAG.InstanceNumber),
    numberOfFrames: numberValue(ds, TAG.NumberOfFrames),
  };
}

/** 画像の番号（InstanceNumber）の順（番号が無い・数でないものは後ろ。同じなら SOPInstanceUID の順） */
export function sortInstances(instances: InstanceSummary[]): InstanceSummary[] {
  const num = (s: InstanceSummary) => (/^-?\d+$/.test(s.instanceNumber.trim()) ? Number(s.instanceNumber) : Number.POSITIVE_INFINITY);
  return [...instances].sort((a, b) => num(a) - num(b) || a.sopInstanceUid.localeCompare(b.sopInstanceUid));
}

/** QIDO-RS の StudyDate の範囲の値（`YYYYMMDD-YYYYMMDD`。片方だけでもよい）。条件が無ければ null */
export function studyDateRange(query: StudyQuery | undefined): string | null {
  const ok = (d: string | undefined) => (d && /^\d{8}$/.test(d) ? d : "");
  const from = ok(query?.dateFrom);
  const to = ok(query?.dateTo);
  if (!from && !to) return null;
  return from === to ? from : `${from}-${to}`;
}

/** 検査日の範囲に入るか（モックと、範囲を返さない画像サーバーの答えの確かめに使う） */
export function inDateRange(studyDate: string, query: StudyQuery | undefined): boolean {
  const from = query?.dateFrom;
  const to = query?.dateTo;
  if (!from && !to) return true;
  if (!/^\d{8}$/.test(studyDate)) return false;
  return (!from || studyDate >= from) && (!to || studyDate <= to);
}

/** 含むかで比べる詳細条件（QIDO-RS では `*値*`） */
const CONTAINS_KEYS = ["accessionNumber", "studyDescription"] as const;
/** QIDO-RS の属性の名前 */
const QIDO_KEYS = {
  patientBirthDate: "PatientBirthDate",
  patientSex: "PatientSex",
  accessionNumber: "AccessionNumber",
  studyDescription: "StudyDescription",
} as const;

/** 文字の条件の語（空白で区切る） */
const words = (value: string) => value.trim().split(/\s+/).filter(Boolean);

/**
 * 詳細条件（docs/spec.md の 3.1）を QIDO-RS の検索の値にする。生年月日・性別は一致、受付番号・検査名は値を含むもの
 * （`*値*`。空白で区切った語は、その順に含むもの：`chest ct` → `*chest*ct*`）。
 * 値は study-filter.ts で、ワイルドカードの字（`*` `?`）・区切りの字（`\` `,`）・制御文字を含まないことを確かめてある
 */
export function studyQueryParams(query: StudyQuery | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const [key, name] of Object.entries(QIDO_KEYS) as [keyof typeof QIDO_KEYS, string][]) {
    const value = query?.[key];
    if (!value) continue;
    out.push([name, (CONTAINS_KEYS as readonly string[]).includes(key) ? `*${words(value).join("*")}*` : value]);
  }
  return out;
}

/** 文字の条件の比べ方：全角と半角・大文字と小文字を区別しない */
const fold = (s: string) => s.normalize("NFKC").toLowerCase();

/** 語を、その順に含むか */
function containsInOrder(haystack: string, needle: string): boolean {
  const text = fold(haystack);
  let from = 0;
  for (const word of words(fold(needle))) {
    const at = text.indexOf(word, from);
    if (at < 0) return false;
    from = at + word.length;
  }
  return true;
}

/**
 * 検査日の範囲と詳細条件に合うか（モックと、画像サーバーの答えの確かめに使う）。文字の条件は、値を含むか
 * （画像サーバーより緩く比べ、画像サーバーが合うとした検査を落とさない）
 */
export function matchesStudyQuery(study: StudySummary, query: StudyQuery | undefined): boolean {
  if (!inDateRange(study.studyDate, query)) return false;
  if (query?.patientBirthDate && study.patientBirthDate.trim() !== query.patientBirthDate) return false;
  if (query?.patientSex && study.patientSex.trim().toUpperCase() !== query.patientSex) return false;
  return CONTAINS_KEYS.every((key) => {
    const needle = query?.[key];
    return !needle || containsInOrder(study[key], needle);
  });
}

/** 新しい検査を上に（検査日・時刻の降順。同じなら StudyInstanceUID の順） */
export function sortStudiesNewestFirst(studies: StudySummary[]): StudySummary[] {
  return [...studies].sort(
    (a, b) =>
      (b.studyDate + b.studyTime).localeCompare(a.studyDate + a.studyTime) ||
      a.studyInstanceUid.localeCompare(b.studyInstanceUid),
  );
}
