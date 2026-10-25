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
  /** 紹介医（PN の1本の文字列） */
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

/** シリーズの中の画像（BFF の側の QIDO-RS で引く。画像単位の DICOM タグの選び先。中継からは返さない） */
export interface InstanceSummary {
  /** 答えにあれば、求めた検査・シリーズのものかを確かめる（無ければ空）。画面へは返さない */
  studyInstanceUid: string;
  seriesInstanceUid: string;
  /** 監査の記録の「どの患者」に使う（無ければ空）。画面へは返さない */
  patientId: string;
  sopInstanceUid: string;
  sopClassUid: string;
  instanceNumber: string;
  numberOfFrames: number | null;
  /** スライス位置 SliceLocation (0020,1041)。画像サーバーの QIDO-RS が返し、値が数のときだけ（それ以外は null）。並びには使わない */
  sliceLocation: number | null;
}

/** 検査の検索の条件。日付は DICOM の DA（YYYYMMDD）。画像サーバーへは QIDO-RS の条件として渡す */
export interface StudyQuery {
  dateFrom?: string;
  dateTo?: string;
  // ── 詳細条件（docs/spec.md の 3.1。2026-10-21）。値は study-filter.ts で形を確かめたもの（ワイルドカードの字を含まない） ──
  /** 生年月日（DA。YYYYMMDD）。一致 */
  patientBirthDate?: string;
  /** 性別（M・F・O）。一致 */
  patientSex?: string;
  /** 受付番号・検査名。値を含むもの（QIDO-RS では `*値*`） */
  accessionNumber?: string;
  studyDescription?: string;
}

/** BFF から見た Orthanc（docs/spec.md の 0。Orthanc 専用）。資格情報はこの中だけで使い、ブラウザには渡さない */
export interface Backend {
  readonly kind: "orthanc";
  readonly mock: boolean;
  /** 発番元を確認した患者 ID で、全検査を REST から探す（design.md §4・§6）。 */
  findStudiesByPatientId(patientId: string): Promise<string[]>;
  /** A40 の空欄を補うために、現在の患者の値を読む（design.md §9）。 */
  studyPatient(orthancStudyId: string): Promise<StudyPatient | null>;
  /**
   * UID を保つ書き換えの仕事を作る（design.md §4）。元は消さない（KeepSource は既定の true）。患者 ID が同じなら
   * OverwriteInstances で元の画像が置き換わる。患者 ID が変わると書き換えた画像は別の検査になり、元の検査も残る。
   * 元の画像は、書き換えた画像を確かめてから deleteStudyInstances で名指しで消す（Orthanc に元を消させると、
   * 書き換えの最中に同じ検査へ届いた画像も一緒に消えうるため。design.md §15）
   */
  modifyStudyKeepingUids(orthancStudyId: string, replace: Record<string, string>): Promise<{ jobId: string }>;
  /**
   * 検査の画像ごとの、Orthanc が持つファイルの印（FileUuid）と、読む前の Orthanc の変更の記録（/changes）の位置。
   * 鍵は UID の組（Study・Series・SOP を `|` でつないだもの）。同じ UID の画像が届き直して置き換わると、印が変わる
   */
  studyInstanceFiles(orthancStudyId: string): Promise<SourceFiles>;
  /**
   * 検査の画像のうち、UID の組（Study・Series・SOP）が instances のどれかと同じで、ファイルの印が source.files と同じ
   * ものだけを 1 枚ずつ消す。消す直前に、変更の記録の source.since より後にその画像が届いた記録（NewInstance）があれば
   * 消さない（同じ UID で届き直した画像）。ほかの画像（後から届いた画像）は残す。すでに無い画像は飛ばす。
   * Orthanc の削除には条件を付けられないので、記録を読んでから消すまでの間に届き直した画像は消えうる（design.md §15.4）
   */
  deleteStudyInstances(orthancStudyId: string, instances: PatientInstance[], source: SourceFiles): Promise<void>;
  /** 要約では見つからない部分反映を、全画像の UID と値で確かめる（design.md §4）。 */
  studyInstanceTags(orthancStudyId: string): Promise<PatientInstance[]>;
  /** 画像が届き終えた検査か（Orthanc の IsStable）。照合の後に届いた画像を書き換える前に見る（design.md §15）。 */
  studyIsStable(orthancStudyId: string): Promise<boolean>;
  /**
   * QIDO-RS の検査の検索（検査日の範囲で絞れる）。検査日の新しい順に limit 件まで。
   * QIDO-RS は返す順を決めていない（PS3.18 8.3.4.4）ので、limit を超える検査があれば、検査日の範囲で区切って
   * 新しい側から問い合わせる（docs/spec.md の 3.1「上限に届いたとき」）
   */
  searchStudies(limit?: number, query?: StudyQuery): Promise<StudySearch>;
  /** 検査の中のシリーズ（QIDO-RS。シリーズの番号の順）。検査が無ければ空 */
  searchSeries(studyInstanceUid: string): Promise<SeriesSummary[]>;
  /**
   * 1件の検査の DICOM の値（QIDO-RS の StudyInstanceUID の検索と includefield=all）。無ければ null。
   * 詳細のパネルは、ここから画面の項目を組み立てる（許可の一覧で絞る）。値の全部をそのまま返すのは、
   * すべての DICOM の値を見る権限（dicom.all_values）のときだけ
   */
  studyDataset(studyInstanceUid: string): Promise<DicomJsonDataset | null>;
  /**
   * シリーズの中の画像（QIDO-RS の studies/{study}/series/{series}/instances。画像の番号の順）。無ければ空。
   * 画像単位の DICOM タグ（dicom.all_values）の選び先。BFF の側で引き、中継からは返さない（docs/spec.md の 3.2）
   */
  searchInstances(studyInstanceUid: string, seriesInstanceUid: string): Promise<InstanceSummary[]>;
  /**
   * 1枚の画像の DICOM の値の全部（WADO-RS の studies/{study}/series/{series}/instances/{sop}/metadata）。無ければ null。
   * 返す前に、答えの3つの UID が求めたものと同じかを確かめる。dicom.all_values のときだけ画面へ返す
   */
  instanceDataset(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string): Promise<DicomJsonDataset | null>;
  /** 検査の件数。Orthanc の /statistics で正確に数える */
  countStudies(): Promise<StudyCount>;
  /**
   * 検査の一覧の版（docs/spec.md の 3.1 の自動更新）。Orthanc の変更の記録の最後の番号（/changes?last の Last）。
   * 検査・シリーズ・画像が入る・消える・変わると進む。患者の情報は含まない
   */
  studyListVersion(): Promise<string>;
  /**
   * ビューアが画像を取る道（WADO-RS の読み取り）の中継。検索（QIDO-RS）と書き込みは通さない（docs/spec.md の 3.2）。
   * 宛先は relay-path.ts の wadoRsTarget で確かめたもの
   */
  relayDicomweb(request: RelayRequest): Promise<Response>;

  // ── 段 4：受け取ったものを見る・機器・送る（docs/spec.md の 3.3・3.4）。Orthanc の REST を使う ──

  /**
   * 受け取った検査（Orthanc の変更の記録 /changes から、新しい順に limit 件まで）。
   * complete=false は、読む範囲（直近の変更の数・読む回数）の上限で止まり、もっと古い受け取りを読めていないこと
   */
  receivedStudies(limit: number): Promise<ReceivedStudies>;
  /** Orthanc に登録された機器（/modalities?expand） */
  listModalities(): Promise<ModalityEntry[]>;
  /** Orthanc から機器へ C-ECHO（/modalities/{id}/echo）。つながったら true。機器が無ければ BackendError(404) */
  echoModality(modalityId: string): Promise<boolean>;
  /**
   * StudyInstanceUID から Orthanc の中の検査の ID（/tools/lookup）。無ければ null。
   * 同じ UID の検査が2つ以上ある（患者違いなど）ときは、どれか1つを選ばずに BackendError(409)
   */
  lookupStudy(studyInstanceUid: string): Promise<string | null>;
  /** StudyInstanceUID に当たる Orthanc の中の検査の ID の全部（/tools/lookup の Type が Study のもの） */
  lookupStudyIds(studyInstanceUid: string): Promise<string[]>;
  /** Orthanc の中の検査の要点と版（/studies/{id}。LastUpdate を版にする）。無ければ null */
  studyInfo(orthancStudyId: string): Promise<OrthancStudyInfo | null>;
  /** 検査を機器へ送る（/modalities/{id}/store を非同期で）。書き込みの操作。Orthanc の仕事の ID を返す */
  sendStudy(modalityId: string, orthancStudyId: string): Promise<{ jobId: string }>;
  /** Orthanc の仕事の状態（/jobs/{id}）。無ければ null */
  jobStatus(jobId: string): Promise<JobStatus | null>;

  // ── 段 5：書き出し・削除（docs/spec.md の 3.5） ──

  /** 検査の画像の全部の ZIP（/studies/{id}/archive）。本文はそのまま流す。無ければ BackendError(404) */
  exportStudy(orthancStudyId: string): Promise<Response>;
  /** 検査を消す（DELETE /studies/{id}）。書き込みの操作。無ければ BackendError(404)。答えが分からなければ BackendUnknownError */
  deleteStudy(orthancStudyId: string): Promise<void>;
}

/** 消す前の確かめに使う、Orthanc の中の検査の要点（docs/spec.md の 3.5 の削除） */
export interface OrthancStudyInfo {
  orthancId: string;
  studyInstanceUid: string;
  patientId: string;
  patientName: string;
  studyDate: string;
  seriesCount: number;
  /** 版（Orthanc の LastUpdate）。確かめの画面を出した後に検査が変われば、この値が変わる */
  version: string;
}

export interface ReceivedStudies {
  studies: ReceivedStudy[];
  /** 読むと決めた範囲を読み切ったうえで、それより古い変更の記録が無い（false なら「ここまでしか読めていない」） */
  complete: boolean;
}

/** 受け取った検査（docs/spec.md の 3.3） */
export interface ReceivedStudy {
  /** Orthanc の中の検査の ID */
  orthancId: string;
  /** 受け取った時刻（Orthanc の時刻を ISO 8601 の形にしたもの。時間帯は Orthanc のサーバーの時刻） */
  receivedAt: string;
  /** C-STORE で送ってきた側の AE タイトル（画像のメタデータ RemoteAET）。分からなければ null */
  remoteAet: string | null;
  /** 入った道（画像のメタデータ Origin。DicomProtocol・RestApi など。Orthanc の版で実測してから使う）。分からなければ null */
  origin: string | null;
  /** 検査の画像の数 */
  instanceCount: number;
  summary: StudySummary;
}

/** Orthanc に登録された機器 */
export interface ModalityEntry {
  /** Orthanc の中の名前 */
  id: string;
  aet: string;
  host: string;
  port: number | null;
  manufacturer: string;
  allowEcho: boolean | null;
  allowStore: boolean | null;
}

export type JobState = "Pending" | "Running" | "Success" | "Failure" | "Paused" | "Retry";

/** Orthanc の仕事の状態（返すのは状態・進み・誤り・時刻だけ） */
export interface JobStatus {
  id: string;
  state: JobState;
  progress: number;
  errorCode: number;
  errorDescription: string;
  creationTime: string;
  completionTime: string | null;
}

/** 書き込みの要求の答えが分からなかった（時間切れ・通信の切れ。docs/spec.md の 3.5 の結果不明） */
export class BackendUnknownError extends Error {
  constructor(message = "画像サーバーの応答を確認できません") {
    super(message);
    this.name = "BackendUnknownError";
  }
}

export interface StudyCount {
  count: number;
  exact: boolean;
}

/** 検査の検索の答え */
export interface StudySearch {
  /** 検査日の新しい順に、上限の数まで */
  studies: StudySummary[];
  /**
   * 条件に合う検査を全部返したか。false なら、返していない検査が画像サーバーにある（件数は「以上」）。
   * 返した検査は、検査日の新しい側から欠けなく並ぶ（いちばん古い検査日の中だけは、全部とは限らない）
   */
  complete: boolean;
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

/** HL7 で書き換える前の値（Orthanc の REST）。 */
export interface StudyPatient {
  PatientID: string;
  PatientName: string;
  PatientBirthDate: string;
  PatientSex: string;
  AccessionNumber: string;
  StudyInstanceUID: string;
}

/** 書き換えの前に読んだ、元の検査の画像ごとのファイルの印と、Orthanc の変更の記録の位置（design.md §15.4） */
export interface SourceFiles {
  since: number;
  files: Record<string, string>;
}

export interface PatientInstance extends StudyPatient {
  SeriesInstanceUID: string;
  SOPInstanceUID: string;
  SpecificCharacterSet: string;
}
