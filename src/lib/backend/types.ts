// 画像サーバーから受けた検査を、画面に出す形にしたもの。
// 氏名・生年月日の整形（漢字とかなに分ける・和暦）は段 2。ここでは DICOM の値をそのまま持つ。
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
  modalities: string[];
  seriesCount: number | null;
  instanceCount: number | null;
}

/** BFF から見た画像サーバー。資格情報はこの中だけで使い、ブラウザには渡さない */
export interface Backend {
  readonly kind: "orthanc" | "dicomweb";
  readonly mock: boolean;
  /** QIDO-RS の検査の検索（新しい順に limit 件まで） */
  searchStudies(limit?: number): Promise<StudySummary[]>;
  /**
   * 検査の件数。Orthanc では /statistics（Orthanc のときだけの部品）で正確に数える。
   * DICOMweb だけのときは QIDO-RS の件数で、上限に届いたら exact=false（「以上」）
   */
  countStudies(): Promise<StudyCount>;
  /** DICOMweb（QIDO-RS・WADO-RS・STOW-RS）への中継。path は `/dicom-web` より後ろ */
  relayDicomweb(request: RelayRequest): Promise<Response>;
}

export interface StudyCount {
  count: number;
  exact: boolean;
}

/** 一覧と件数で、一度に QIDO-RS から受ける検査の上限 */
export const STUDY_LIMIT = 1000;

export interface RelayRequest {
  method: string;
  /** 例：["studies", "1.2.3", "series"] */
  segments: string[];
  search: string;
  accept?: string | null;
  contentType?: string | null;
  body?: ArrayBuffer | null;
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
