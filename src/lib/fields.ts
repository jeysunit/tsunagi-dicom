import type { Role } from "@/lib/auth/roles";
import type { SeriesSummary, StudySummary } from "@/lib/backend/types";
import { parsePatientName } from "@/lib/format/patient-name";
import { EMPTY_STATE, type StudyStateView } from "@/lib/study-state";

// 役割ごとの許可の一覧（docs/spec.md 原則 8）。
// 画面の API（BFF が組み立てて返す JSON）は、ここに載った項目だけを返す。画像サーバーの応答をそのまま返さない。
// - 項目は、画面に出す形の名前で持つ（DICOM のタグの名前ではない）。BFF が画像サーバーの応答から組み立てる。
// - 役割の一覧に無い項目は返さない。一覧に無い役割は何も返さない（足し忘れたときは「出ない」側に倒れる）。
// - 既定の役割（管理者・医師・技師・閲覧）は、その役割が使える画面に要る項目をすべて含む（見え方は変えない）。
// - すべての DICOM の値を見る権限（dicom.all_values。src/lib/auth/roles.ts）は、この一覧とは別に持つ。
// - 画像と文書の本体、ビューアへ渡す取得の道（中継の WADO-RS）は、この選別の対象にしない。
// 画面に項目を足すときは、ここに足し、「載っていない項目は返らない」試験（tests/unit/fields.test.ts）を付ける。

/** 検査の一覧の1行の項目 */
export const STUDY_FIELDS = [
  "studyInstanceUid",
  "patientId",
  /** 漢字の氏名（漢字が無ければローマ字。src/lib/format/patient-name.ts） */
  "patientName",
  /** かなの氏名 */
  "patientKana",
  /** ローマ字の氏名（英字） */
  "patientNameAlphabetic",
  "patientBirthDate",
  "patientSex",
  "studyDate",
  "studyTime",
  "accessionNumber",
  "studyDescription",
  "studyId",
  /** 依頼医（漢字が無ければローマ字） */
  "referringPhysicianName",
  "modalities",
  "seriesCount",
  "instanceCount",
  // BFF のデータベースの状態（src/lib/study-state.ts）
  "inspected",
  "read",
  "urgent",
  "bookmarked",
  /** 検査ごとに覚えたビューア（無ければ null） */
  "rememberedViewer",
  /** ダブルクリックで開く既定のビューア（覚え → モダリティの既定） */
  "defaultViewer",
] as const;
export type StudyField = (typeof STUDY_FIELDS)[number];

/** 詳細のパネルのシリーズの項目 */
export const SERIES_FIELDS = [
  "seriesInstanceUid",
  "modality",
  "seriesNumber",
  "seriesDescription",
  "bodyPartExamined",
  "seriesDate",
  "instanceCount",
] as const;
export type SeriesField = (typeof SERIES_FIELDS)[number];
export type SeriesView = Partial<SeriesSummary>;

/** BFF の中で組み立てる、検査の一覧の1行の全部の項目（ブラウザへはそのまま返さない） */
export interface StudyRecord {
  studyInstanceUid: string;
  patientId: string;
  patientName: string;
  patientKana: string;
  patientNameAlphabetic: string;
  patientBirthDate: string;
  patientSex: string;
  studyDate: string;
  studyTime: string;
  accessionNumber: string;
  studyDescription: string;
  studyId: string;
  referringPhysicianName: string;
  modalities: string[];
  seriesCount: number | null;
  instanceCount: number | null;
  inspected: boolean;
  read: boolean;
  urgent: boolean;
  bookmarked: boolean;
  rememberedViewer: string | null;
  defaultViewer: string | null;
}

/** 画面の API が返す1行。役割に許された項目だけがある */
export type StudyView = Partial<StudyRecord>;

export interface FieldAllowlist {
  study: readonly StudyField[];
  series: readonly SeriesField[];
}

export type FieldAllowlistMap = Record<Role, FieldAllowlist>;

/** 既定の役割の許可の一覧。どの既定の役割も、検査の一覧の画面に要る項目をすべて見る（原則 8） */
export const ROLE_FIELD_ALLOWLIST: FieldAllowlistMap = {
  admin: { study: STUDY_FIELDS, series: SERIES_FIELDS },
  doctor: { study: STUDY_FIELDS, series: SERIES_FIELDS },
  technologist: { study: STUDY_FIELDS, series: SERIES_FIELDS },
  viewer: { study: STUDY_FIELDS, series: SERIES_FIELDS },
};

/** 役割の許可の一覧。一覧に無い役割は空（何も返さない） */
export function allowlistFor(role: Role, map: FieldAllowlistMap = ROLE_FIELD_ALLOWLIST): FieldAllowlist {
  return Object.hasOwn(map, role) ? map[role] : { study: [], series: [] };
}

/**
 * 画像サーバーの応答（StudySummary）と BFF の状態から、画面の項目を組み立てる。氏名は漢字・かな・ローマ字に分ける
 */
export function studyRecord(
  s: StudySummary,
  state: StudyStateView = EMPTY_STATE,
  defaultViewer: string | null = null,
): StudyRecord {
  const name = parsePatientName(s.patientName);
  return {
    studyInstanceUid: s.studyInstanceUid,
    patientId: s.patientId,
    patientName: name.name,
    patientKana: name.kana,
    patientNameAlphabetic: name.alphabetic,
    patientBirthDate: s.patientBirthDate,
    patientSex: s.patientSex,
    studyDate: s.studyDate,
    studyTime: s.studyTime,
    accessionNumber: s.accessionNumber,
    studyDescription: s.studyDescription,
    studyId: s.studyId,
    referringPhysicianName: parsePatientName(s.referringPhysicianName).name,
    modalities: [...s.modalities],
    seriesCount: s.seriesCount,
    instanceCount: s.instanceCount,
    inspected: state.inspected,
    read: state.read,
    urgent: state.urgent,
    bookmarked: state.bookmarked,
    rememberedViewer: state.rememberedViewer,
    defaultViewer,
  };
}

/**
 * 許された項目だけを持つ、新しい物を作る。元の物にある、一覧に無い項目は写さない
 * （元の物を削るのではなく、一覧の項目だけを拾う。足し忘れは「出ない」側に倒れる）
 */
export function pickFields<K extends string>(
  record: Partial<Record<K, unknown>>,
  known: readonly K[],
  allowed: readonly K[],
): Partial<Record<K, unknown>> {
  const out: Partial<Record<K, unknown>> = {};
  for (const key of known) {
    if (allowed.includes(key) && Object.hasOwn(record, key)) out[key] = record[key];
  }
  return out;
}

/** 組み立てた1行を、役割の許可の一覧で絞る */
export function projectStudy(record: StudyRecord, allowlist: FieldAllowlist): StudyView {
  return pickFields(record, STUDY_FIELDS, allowlist.study) as StudyView;
}

/** 検査の一覧の1行を、役割の許可の一覧で絞る */
export function studyView(
  s: StudySummary,
  allowlist: FieldAllowlist,
  state?: StudyStateView,
  defaultViewer?: string | null,
): StudyView {
  return projectStudy(studyRecord(s, state, defaultViewer), allowlist);
}

/** シリーズを、役割の許可の一覧で絞る */
export function seriesView(s: SeriesSummary, allowlist: FieldAllowlist): SeriesView {
  return pickFields({ ...s }, SERIES_FIELDS, allowlist.series) as SeriesView;
}
