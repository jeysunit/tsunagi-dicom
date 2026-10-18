import type { DicomJsonDataset } from "@/lib/backend/dicom-json";
import type { WadoRsTarget } from "@/lib/backend/relay-path";

// 画像サーバーから受けた検査を、画面に出す形にしたもの。
// 氏名・生年月日の整形（漢字とかなに分ける・和暦）は画面の項目を組み立てるとき（src/lib/fields.ts）。
// ここでは DICOM の値をそのまま持つ。ブラウザへはそのまま返さない（原則 8）。
export interface StudySummary {
  studyInstanceUid: string;
  patientId: string;
  /** DICOM の PN を Alphabetic=Ideographic=Phonetic の1本の文字列にしたもの */
  patientName: string;
  patientBirthDate: string;
  patientSex: string;
  studyDate: string;
  studyTime: string;
  accessionNumber: string;
  studyDescription: string;
  /** StudyID（装置・施設の検査の番号） */
  studyId: string;
  /** 依頼医（PN の1本の文字列） */
  referringPhysicianName: string;
  modalities: string[];
  seriesCount: number | null;
  instanceCount: number | null;
}

/** 検査の中のシリーズ（BFF の側の QIDO-RS で引く。中継からは返さない） */
export interface SeriesSummary {
  seriesInstanceUid: string;
  modality: string;
  seriesNumber: string;
  seriesDescription: string;
  bodyPartExamined: string;
  seriesDate: string;
  instanceCount: number | null;
}

/** 検査の検索の条件。日付は DICOM の DA（YYYYMMDD）。画像サーバーへは QIDO-RS の条件として渡す */
export interface StudyQuery {
  dateFrom?: string;
  dateTo?: string;
}

/** BFF から見た画像サーバー。資格情報はこの中だけで使い、ブラウザには渡さない */
export interface Backend {
  readonly kind: "orthanc" | "dicomweb";
  readonly mock: boolean;
  /** QIDO-RS の検査の検索（新しい順に limit 件まで。検査日の範囲で絞れる） */
  searchStudies(limit?: number, query?: StudyQuery): Promise<StudySummary[]>;
  /** 検査の中のシリーズ（QIDO-RS。シリーズの番号の順）。検査が無ければ空 */
  searchSeries(studyInstanceUid: string): Promise<SeriesSummary[]>;
  /**
   * 1件の検査の DICOM の値（QIDO-RS の StudyInstanceUID の検索と includefield=all）。無ければ null。
   * 詳細のパネルは、ここから画面の項目を組み立てる（許可の一覧で絞る）。値の全部をそのまま返すのは、
   * すべての DICOM の値を見る権限（dicom.all_values）のときだけ
   */
  studyDataset(studyInstanceUid: string): Promise<DicomJsonDataset | null>;
  /**
   * 検査の件数。Orthanc では /statistics（Orthanc のときだけの部品）で正確に数える。
   * DICOMweb だけのときは QIDO-RS の件数で、上限に届いたら exact=false（「以上」）
   */
  countStudies(): Promise<StudyCount>;
  /**
   * ビューアが画像を取る道（WADO-RS の読み取り）の中継。検索（QIDO-RS）と書き込みは通さない（docs/spec.md の 3.2）。
   * 宛先は relay-path.ts の wadoRsTarget で確かめたもの
   */
  relayDicomweb(request: RelayRequest): Promise<Response>;
}

export interface StudyCount {
  count: number;
  exact: boolean;
}

/** 一覧と件数で、一度に QIDO-RS から受ける検査の上限 */
export const STUDY_LIMIT = 1000;

/** 検索の件数を 1〜STUDY_LIMIT に収める（数でなければ上限） */
export function clampStudyLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return STUDY_LIMIT;
  return Math.min(STUDY_LIMIT, Math.max(1, Math.floor(limit)));
}

export interface RelayRequest {
  /** 読み取りだけ */
  method: "GET" | "HEAD";
  target: WadoRsTarget;
  /** 例：`?quality=90`。`?` を含む。無ければ空 */
  search: string;
  accept?: string | null;
}

export class BackendError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
