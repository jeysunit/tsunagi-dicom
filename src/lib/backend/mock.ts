import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import {
  checkedPatientId,
  studyPatientFromRest,
  firstInstanceId,
  isOrthancId,
  jobFromRest,
  modalitiesFromRest,
  orthancTime,
  collectReceivedInPeriod,
  parseChanges,
  singleStudyId,
  stableFromRest,
  studyInfoFromRest,
  receptionFromMetadata,
  studyFromRest,
} from "@/lib/backend/orthanc-rest";
import {
  matchesStudyQuery,
  sortInstances,
  sortSeries,
  sortStudiesNewestFirst,
  stringValue,
  studyFromDicomJson,
  TAG,
  type DicomJsonDataset,
} from "@/lib/backend/dicom-json";
import { isAcceptableImageAccept, wadoRsTarget } from "@/lib/backend/relay-path";
import { readDicomFileHeader } from "@/lib/dicom-file";
import {
  BackendError,
  BackendUnknownError,
  clampStudyLimit,
  STUDY_LIMIT,
  type Backend,
  type InstanceSummary,
  type ReceivedStudy,
  type ReceivedWindow,
  type RelayRequest,
  type SeriesSummary,
  type StudyQuery,
} from "@/lib/backend/types";

// モックのバックエンド（BACKEND_MOCK=true）。Orthanc の形で、tests/fixtures/orthanc の合成の見本を返す
// （Orthanc の DICOMweb のプラグインと Orthanc の REST の応答の写し）。
// - 検査の検索は QIDO-RS の写し（dicom-web/studies.json）。件数は Orthanc の REST の /statistics の写し。
// - シリーズは Orthanc の REST の写し（rest/series・rest/studies）から組み立てる（QIDO-RS の写しは1件の検査の分しか無いため）。
// - 中継（WADO-RS の読み取り）は、サムネイル（thumbnail・rendered）だけ、写しのある1枚の画像（rest/instances/{id}/preview.png）を返す。
//   ほかの宛先は、確かめたうえで 404 を返す。
// - 段 4：受け取りの記録・機器・C-ECHO・送るは、Orthanc Book の形に合わせて手で作った見本（tests/fixtures/orthanc/made）と、
//   このプロセスの記憶の中の仕事（job）で返す。送ると、仕事は読むたびに Pending → Running → Success（機器 offline へは Failure）と進む。
//   機器 offline は C-ECHO に答えない。
// - 段 5：書き出しは、画像の本体を入れない小さな ZIP を返す。削除は、このプロセスの記憶の中で検査を隠す（見本のファイルは変えない。
//   消した検査は、検索・詳細・受け取りの記録・引き当て・中継のどれにも出さない）。
// - 段 6：インポートは、見本の検査（消した検査を含む）の StudyInstanceUID のファイルだけを受け、その検査を出し直して印を付ける
//   （このプロセスの記憶の中だけ。画像の本体は持たない）。
// - 画像単位の DICOM タグ（2026-10-21）：シリーズの中の画像は REST の写しの Instances の並びから作る。画像の写しが1枚しか無いので、
//   ほかの画像の SOPInstanceUID と値は、Orthanc の ID から決まる合成の値にする（instanceDatasetOf）。

/** モックの仕事（このプロセスの記憶の中だけ。Next.js が部品を分けて組んでも1つにする） */
interface MockJob {
  id: string;
  modality: string;
  study: string;
  reads: number;
  creationTime: string;
}
const JOBS_KEY = Symbol.for("tsunagi-dicom.mock-jobs");
const jobsHolder = globalThis as typeof globalThis & { [JOBS_KEY]?: Map<string, MockJob> };
const mockJobs = (jobsHolder[JOBS_KEY] ??= new Map<string, MockJob>());

/** モックの /changes が 1 回に返す数の上限（実の Orthanc が切り詰める形をまねる。BFF が Last から続けて読むことを試す） */
const MOCK_CHANGES_MAX = 5;
const UPDATES_KEY = Symbol.for("tsunagi-dicom.mock-hl7");
const updatesHolder = globalThis as typeof globalThis & { [UPDATES_KEY]?: Map<string, { id: string; replace: Record<string, string> }> };
const mockUpdates = (updatesHolder[UPDATES_KEY] ??= new Map<string, { id: string; replace: Record<string, string> }>());

const orthancNow = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

/** モックで消した検査（StudyInstanceUID。段 5）。このプロセスの記憶の中だけで、見本のファイルは変えない */
const DELETED_KEY = Symbol.for("tsunagi-dicom.mock-deleted");
const deletedHolder = globalThis as typeof globalThis & { [DELETED_KEY]?: Set<string> };
const mockDeleted = (deletedHolder[DELETED_KEY] ??= new Set<string>());

/** 試験のための、モックの Orthanc の中の変化（同じ UID の検査が2つある・確かめの後に検査が変わった） */
const TEST_KEY = Symbol.for("tsunagi-dicom.mock-test");
const testHolder = globalThis as typeof globalThis & {
  [TEST_KEY]?: { extraIds: Map<string, string[]>; versions: Map<string, string>; revision: number };
};
const mockTest = (testHolder[TEST_KEY] ??= { extraIds: new Map(), versions: new Map(), revision: 0 });

/**
 * 中身の訂正で作った検査（新しい StudyInstanceUID → 元の検査と直した値。段 6）。このプロセスの記憶の中だけ。
 * 元の検査の値を写し、StudyInstanceUID・SeriesInstanceUID・SOPInstanceUID を新しくした形で、検索・引き当て・詳細に出す
 */
const COPIES_KEY = Symbol.for("tsunagi-dicom.mock-copies");
const copiesHolder = globalThis as typeof globalThis & {
  [COPIES_KEY]?: Map<string, { id: string; sourceUid: string; replace: Record<string, string> }>;
};
const mockCopies = (copiesHolder[COPIES_KEY] ??= new Map<string, { id: string; sourceUid: string; replace: Record<string, string> }>());
/** 中身の訂正で直せる値の DICOM のタグと VR */
const CONTENT_TAGS: Record<string, [string, string]> = { StudyDate: ["00080020", "DA"], StudyDescription: ["00081030", "LO"] };

/** 試験のため：モックで消した検査と、試験の変化を戻す */
export function restoreMockStudies(): void {
  mockDeleted.clear();
  mockUpdates.clear();
  mockCopies.clear();
  hl7Jobs.clear();
  hl7Instances.clear();
  hl7Locks.clear();
  hl7LockLog.length = 0;
  hl7Simulation = {};
  mockImported.instances.clear();
  mockImported.labels.clear();
  mockImport = {};
  mockTest.revision = 0;
  mockTest.extraIds.clear();
  mockTest.versions.clear();
}

/** 試験のため：同じ StudyInstanceUID の検査が、Orthanc にもう1つある形にする（患者違いの重なりなど） */
export function duplicateMockStudy(studyInstanceUid: string): void {
  mockTest.extraIds.set(studyInstanceUid, ["00000000-00000000-00000000-00000000-00000001"]);
}

/** 試験のため：検査の版（LastUpdate）を替える（確かめの画面を出した後に、検査が変わった形） */
export function touchMockStudy(orthancStudyId: string): void {
  mockTest.versions.set(orthancStudyId, orthancNow());
}

/** 書き出しの ZIP の中身（モック。画像の本体は入れず、検査の UID を書いた1つのテキストのファイル）を、圧縮しない ZIP にする */
function mockZip(name: string, text: string): Uint8Array<ArrayBuffer> {
  const data = Buffer.from(text, "utf8");
  const file = Buffer.from(name, "utf8");
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // 名前は UTF-8
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(file.length, 28);
  const localSize = local.length + file.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(localSize, 16);
  const all = Buffer.concat([local, file, data, central, file, end]);
  const out = new Uint8Array(new ArrayBuffer(all.length));
  out.set(all);
  return out;
}

export function fixturesDir(): string {
  return path.join(process.cwd(), "tests", "fixtures", "orthanc");
}

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDir(), ...parts), "utf8")) as T;
}

interface RestStudy {
  ID: string;
  originalId?: string;
  MainDicomTags: { StudyInstanceUID?: string };
  PatientMainDicomTags: Record<string, string | undefined>;
}
interface RestSeries {
  ID: string;
  ParentStudy: string;
  Instances: string[];
  MainDicomTags: Record<string, string | undefined>;
}
interface RestInstance {
  ID: string;
  ParentSeries: string;
  MainDicomTags: { SOPInstanceUID?: string; InstanceNumber?: string; AcquisitionNumber?: string; ImagePositionPatient?: string };
}

/** モックの画像（画像単位の DICOM タグの見本） */
interface MockInstance {
  series: RestSeries;
  tags: RestInstance["MainDicomTags"];
  summary: InstanceSummary;
}

/** モダリティごとの SOP Class（CT Image Storage・MR Image Storage・ほかは Secondary Capture Image Storage） */
const SOP_CLASS: Record<string, string> = {
  CT: "1.2.840.10008.5.1.4.1.1.2",
  MR: "1.2.840.10008.5.1.4.1.1.4",
  OT: "1.2.840.10008.5.1.4.1.1.7",
};

/** 写しの無い画像の SOPInstanceUID（Orthanc の ID から決まる、2.25 の形の UID。64 字に収まる） */
function syntheticUid(orthancId: string): string {
  return `2.25.${BigInt(`0x${createHash("sha256").update(orthancId).digest("hex").slice(0, 30)}`)}`;
}

/** 書き換えの元の画像の、Orthanc の ID の形の ID（UID の組から決める。写しの ModifiedFrom と照らす） */
function mockInstanceId(key: string): string {
  return createHash("sha256").update(`instance:${key}`).digest("hex").slice(0, 40).match(/.{8}/g)!.join("-");
}

/** シリーズの MainDicomTags の VR（画像単位の DICOM タグの見本に入れるもの） */
const SERIES_TAGS: Record<string, [string, string]> = {
  Modality: ["00080060", "CS"],
  SeriesDate: ["00080021", "DA"],
  SeriesTime: ["00080031", "TM"],
  Manufacturer: ["00080070", "LO"],
  SeriesDescription: ["0008103E", "LO"],
  BodyPartExamined: ["00180015", "CS"],
  SeriesInstanceUID: ["0020000E", "UI"],
  SeriesNumber: ["00200011", "IS"],
};

/** 検査の単位の検索だけにある項目（画像の値には無い）。画像単位の見本からは外す */
const STUDY_ONLY = new Set(["00080056", "00080061", "00081190", "00201206", "00201208"]);

/**
 * 1枚の画像の DICOM の値の見本（WADO-RS の metadata の形）。検査の値（QIDO-RS の写し）に、シリーズと画像の値を足す。
 * 画像の位置（ImagePositionPatient）は、写しがあればその値、無ければ画像の番号から決める（画像ごとに値が違う形の見本）
 */
function instanceDatasetOf(study: DicomJsonDataset, instance: MockInstance): DicomJsonDataset {
  const ds: DicomJsonDataset = {};
  for (const [key, value] of Object.entries(study)) if (!STUDY_ONLY.has(key)) ds[key] = value;
  for (const [name, [tag, vr]] of Object.entries(SERIES_TAGS)) {
    const v = instance.series.MainDicomTags[name];
    if (v) ds[tag] = { vr, Value: [v] };
  }
  const { summary, tags } = instance;
  const position = tags.ImagePositionPatient ?? `-160.0\\-160.0\\${(-55 + Number(summary.instanceNumber) * 5).toFixed(1)}`;
  ds[TAG.SOPClassUID] = { vr: "UI", Value: [summary.sopClassUid] };
  ds[TAG.SOPInstanceUID] = { vr: "UI", Value: [summary.sopInstanceUid] };
  ds[TAG.InstanceNumber] = { vr: "IS", Value: [summary.instanceNumber] };
  ds["00200012"] = { vr: "IS", Value: [tags.AcquisitionNumber ?? "1"] };
  ds["00200032"] = { vr: "DS", Value: position.split("\\") };
  // 画像ごとの「主なタグ」（docs/spec.md の 3.1）の見本：画像の形と表示の値（合成の値。どの画像も同じ）
  ds["00080008"] = { vr: "CS", Value: ["ORIGINAL", "PRIMARY", "AXIAL"] };
  ds["00200037"] = { vr: "DS", Value: ["1", "0", "0", "0", "1", "0"] };
  ds["00280010"] = { vr: "US", Value: [512] };
  ds["00280011"] = { vr: "US", Value: [512] };
  ds["00280030"] = { vr: "DS", Value: ["0.625", "0.625"] };
  ds["00280004"] = { vr: "CS", Value: ["MONOCHROME2"] };
  ds["00280100"] = { vr: "US", Value: [16] };
  ds["00280101"] = { vr: "US", Value: [12] };
  ds["00281050"] = { vr: "DS", Value: ["40"] };
  ds["00281051"] = { vr: "DS", Value: ["400"] };
  // 値の出し方の見本（ImageComments）：3 枚目は HTML の形の値（文字のまま出す）、4 枚目は長い値（1024 文字で切る）
  if (summary.instanceNumber === "3") ds["00204000"] = { vr: "LT", Value: ["<b>x</b>"] };
  if (summary.instanceNumber === "4") ds["00204000"] = { vr: "LT", Value: ["試験の画像の注記。".repeat(500)] };
  ds["7FE00010"] = { vr: "OW", BulkDataURI: "bulk" };
  return ds;
}

async function readAll<T>(dir: string): Promise<T[]> {
  const names = (await readdir(path.join(fixturesDir(), "rest", dir))).filter((n) => n.endsWith(".json"));
  return Promise.all(names.map((n) => readJson<T>("rest", dir, n)));
}

/** 写しのある、サムネイルの1枚 */
interface PreviewImage {
  studyInstanceUid: string;
  seriesInstanceUid: string;
  sopInstanceUid: string;
  /** PNG の写し（同じ名前の .jpg が JPEG の写し） */
  file: string;
}

export function createMockBackend(): Backend {
  // 消した検査は、どの読み取りにも出さない
  /** 見本の検査に、中身の訂正で作った検査（元の検査の値の写しに、新しい UID と直した値を入れたもの）を足す */
  const withCopies = (datasets: DicomJsonDataset[]) => [
    ...datasets,
    ...[...mockCopies].flatMap(([uid, copy]) => {
      const source = datasets.find((ds) => stringValue(ds, TAG.StudyInstanceUID) === copy.sourceUid);
      if (!source) return [];
      const ds = structuredClone(source);
      ds[TAG.StudyInstanceUID] = { vr: "UI", Value: [uid] };
      for (const [name, value] of Object.entries(copy.replace)) {
        const tag = CONTENT_TAGS[name];
        if (tag) ds[tag[0]] = value === "" ? { vr: tag[1] } : { vr: tag[1], Value: [value] };
      }
      return [ds];
    }),
  ];
  const qidoStudies = async () =>
    withCopies(await readJson<DicomJsonDataset[]>("dicom-web", "studies.json")).filter(
      (ds) => !mockDeleted.has(stringValue(ds, TAG.StudyInstanceUID)),
    ).map((ds) => {
      const update = mockUpdates.get(stringValue(ds, TAG.StudyInstanceUID));
      if (!update) return ds;
      const copy = structuredClone(ds);
      const tags: Record<string, string> = { PatientID: "00100020", PatientName: "00100010", PatientBirthDate: "00100030", PatientSex: "00100040", AccessionNumber: "00080050" };
      for (const [name, value] of Object.entries(update.replace)) {
        const tag = tags[name];
        if (tag) copy[tag] = { vr: ({ PatientID: "LO", PatientName: "PN", PatientBirthDate: "DA", PatientSex: "CS", AccessionNumber: "SH" } as Record<string, string>)[name]!, Value: name === "PatientName" ? [{ Alphabetic: value.split("=")[0], Ideographic: value.split("=")[1], Phonetic: value.split("=")[2] }] : [value] };
      }
      return copy;
    });
  const restCopies = <T extends RestStudy>(studies: T[]): T[] => [
    ...studies,
    ...[...mockCopies].flatMap(([uid, copy]) => {
      const source = studies.find((s) => s.MainDicomTags.StudyInstanceUID === copy.sourceUid);
      if (!source) return [];
      const main = { ...source.MainDicomTags, StudyInstanceUID: uid, ...copy.replace };
      return [{ ...structuredClone(source), ID: copy.id, originalId: copy.id, MainDicomTags: main } as T];
    }),
  ];
  const restStudies = async <T extends RestStudy>() =>
    restCopies(await readAll<T>("studies")).filter((s) => !mockDeleted.has(s.MainDicomTags.StudyInstanceUID ?? "")).map((s) => {
      const update = mockUpdates.get(s.MainDicomTags.StudyInstanceUID ?? "");
      if (!update) return s;
      return { ...s, originalId: s.ID, ID: update.id, PatientMainDicomTags: { ...s.PatientMainDicomTags, ...Object.fromEntries(Object.entries(update.replace).filter(([k]) => k.startsWith("Patient"))) }, MainDicomTags: { ...s.MainDicomTags, ...(update.replace.AccessionNumber !== undefined ? { AccessionNumber: update.replace.AccessionNumber } : {}) } };
    });

  async function restSeriesByStudy(): Promise<Map<string, RestSeries[]>> {
    const [studies, series] = await Promise.all([restStudies(), readAll<RestSeries>("series")]);
    const uidById = new Map(studies.map((s) => [s.originalId ?? s.ID, s.MainDicomTags.StudyInstanceUID ?? ""]));
    const out = new Map<string, RestSeries[]>();
    for (const s of series) {
      const uid = uidById.get(s.ParentStudy);
      if (!uid) continue;
      out.set(uid, [...(out.get(uid) ?? []), s]);
    }
    // 中身の訂正で作った検査のシリーズ：元の検査のシリーズの写しに、新しい SeriesInstanceUID を入れる
    for (const [uid, copy] of mockCopies) {
      if (!studies.some((s) => s.MainDicomTags.StudyInstanceUID === uid)) continue;
      out.set(uid, (out.get(copy.sourceUid) ?? []).map((s) => ({
        ...s,
        ID: mockInstanceId(`${uid}|${s.ID}`),
        ParentStudy: copy.id,
        MainDicomTags: { ...s.MainDicomTags, SeriesInstanceUID: syntheticUid(`${uid}|${s.MainDicomTags.SeriesInstanceUID ?? ""}`) },
      })));
    }
    return out;
  }

  /** シリーズの中の画像（Orthanc の REST の写しの Instances の並び）。写しのある画像はその値、ほかは ID から決まる合成の値 */
  async function mockInstances(studyInstanceUid: string, seriesInstanceUid: string): Promise<MockInstance[]> {
    const series = ((await restSeriesByStudy()).get(studyInstanceUid) ?? []).find(
      (s) => s.MainDicomTags.SeriesInstanceUID === seriesInstanceUid,
    );
    if (!series) return [];
    const study = (await qidoStudies()).find((ds) => stringValue(ds, TAG.StudyInstanceUID) === studyInstanceUid);
    const patientId = study ? stringValue(study, TAG.PatientID) : "";
    const copied = new Map((await readAll<RestInstance>("instances")).map((i) => [i.ID, i]));
    // 写しの無い画像の番号は、写しの画像の番号と重ならないように 1 から振る
    const used = new Set(series.Instances.map((id) => copied.get(id)?.MainDicomTags.InstanceNumber).filter(Boolean));
    let next = 1;
    const nextNumber = () => {
      while (used.has(String(next))) next += 1;
      return String(next++);
    };
    return series.Instances.map((id) => {
      const tags = copied.get(id)?.MainDicomTags;
      const instanceNumber = tags?.InstanceNumber ?? nextNumber();
      // スライス位置の見本：画像の位置（ImagePositionPatient）の 3 つ目。画像サーバーが返さない形は、実機の側で試す
      const z = Number(tags?.ImagePositionPatient?.split("\\")[2] ?? -55 + Number(instanceNumber) * 5);
      return {
        series,
        tags: tags ?? {},
        summary: {
          studyInstanceUid,
          seriesInstanceUid,
          patientId,
          // 中身の訂正で作った検査の画像は、新しい SOPInstanceUID にする
          sopInstanceUid: mockCopies.has(studyInstanceUid) ? syntheticUid(`${studyInstanceUid}|${id}`) : tags?.SOPInstanceUID ?? syntheticUid(id),
          sopClassUid: SOP_CLASS[series.MainDicomTags.Modality ?? ""] ?? SOP_CLASS.OT!,
          instanceNumber,
          numberOfFrames: null,
          sliceLocation: Number.isFinite(z) ? z : null,
        },
      };
    });
  }

  async function previews(): Promise<PreviewImage[]> {
    const [byStudy, instances] = await Promise.all([restSeriesByStudy(), readAll<RestInstance>("instances")]);
    const out: PreviewImage[] = [];
    for (const inst of instances) {
      for (const [studyUid, series] of byStudy) {
        const parent = series.find((s) => s.ID === inst.ParentSeries);
        if (parent && inst.MainDicomTags.SOPInstanceUID) {
          out.push({
            studyInstanceUid: studyUid,
            seriesInstanceUid: parent.MainDicomTags.SeriesInstanceUID ?? "",
            sopInstanceUid: inst.MainDicomTags.SOPInstanceUID,
            file: path.join(fixturesDir(), "rest", "instances", inst.ID, "preview.png"),
          });
        }
      }
    }
    return out;
  }

  return {
    kind: "orthanc",
    mock: true,

    async searchStudies(limit = STUDY_LIMIT, query?: StudyQuery) {
      // 検査日の範囲と詳細条件は、実の Orthanc の QIDO-RS の代わりに、ここで当てる
      const studies = (await qidoStudies()).map(studyFromDicomJson).filter((s) => matchesStudyQuery(s, query));
      const max = clampStudyLimit(limit);
      return { studies: sortStudiesNewestFirst(studies).slice(0, max), complete: studies.length <= max };
    },

    async countStudies() {
      const stats = await readJson<{ CountStudies: number }>("rest", "statistics.json");
      return { count: stats.CountStudies + mockCopies.size - mockDeleted.size, exact: true };
    },

    async studyListVersion() {
      // 見本の変更の記録の最後の番号に、このプロセスで消した検査の数と HL7 の更新の数を足す（消すと、実の Orthanc の Deleted の出来事と同じく進む）
      const { last } = parseChanges(await readJson<unknown>("made", "changes.json"));
      return String(last + mockDeleted.size + mockTest.revision);
    },

    async searchSeries(studyInstanceUid: string) {
      const series = (await restSeriesByStudy()).get(studyInstanceUid) ?? [];
      return sortSeries(
        series.map(
          (s): SeriesSummary => ({
            seriesInstanceUid: s.MainDicomTags.SeriesInstanceUID ?? "",
            modality: s.MainDicomTags.Modality ?? "",
            seriesNumber: s.MainDicomTags.SeriesNumber ?? "",
            seriesDescription: s.MainDicomTags.SeriesDescription ?? "",
            bodyPartExamined: s.MainDicomTags.BodyPartExamined ?? "",
            seriesDate: s.MainDicomTags.SeriesDate ?? "",
            instanceCount: s.Instances.length,
          }),
        ),
      );
    },

    async studyDataset(studyInstanceUid: string) {
      return (await qidoStudies()).find((ds) => stringValue(ds, TAG.StudyInstanceUID) === studyInstanceUid) ?? null;
    },

    async searchInstances(studyInstanceUid: string, seriesInstanceUid: string) {
      return sortInstances((await mockInstances(studyInstanceUid, seriesInstanceUid)).map((i) => i.summary));
    },

    async instanceDataset(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
      const found = (await mockInstances(studyInstanceUid, seriesInstanceUid)).find((i) => i.summary.sopInstanceUid === sopInstanceUid);
      const study = (await qidoStudies()).find((ds) => stringValue(ds, TAG.StudyInstanceUID) === studyInstanceUid);
      return found && study ? instanceDatasetOf(study, found) : null;
    },

    async relayDicomweb(req: RelayRequest) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new BackendError("中継は読み取りだけ", 405);
      const target = wadoRsTarget(req.target.path.split("/"));
      if (!target || target.path !== req.target.path) throw new BackendError("中継は WADO-RS の読み取りだけ", 404);

      const last = target.path.split("/").at(-1);
      if (last === "thumbnail" || last === "rendered") {
        // 実の Orthanc と同じく、受け付けない Accept（ブラウザの <img> の Accept など）には 400 を返す。
        // BFF が Accept を決める前の値が来たら、ここで見つかる（画面の経路は withRelayAccept を通す）
        if (!isAcceptableImageAccept(req.accept)) {
          return Response.json({ error: "Unsupported MIME type" }, { status: 400 });
        }
        const image = (await previews()).find(
          (p) =>
            p.studyInstanceUid === target.studyInstanceUid &&
            (!target.seriesInstanceUid || p.seriesInstanceUid === target.seriesInstanceUid) &&
            (!target.sopInstanceUid || p.sopInstanceUid === target.sopInstanceUid),
        );
        if (image) {
          // 求めた型で返す（image/png には PNG、image/jpeg と Accept の無い要求には、rendered の既定の JPEG。PS3.18 8.7.4）
          const png = req.accept === "image/png";
          const body = await readFile(png ? image.file : image.file.replace(/\.png$/, ".jpg"));
          return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": png ? "image/png" : "image/jpeg" } });
        }
      }
      return Response.json({ error: "見本に無い" }, { status: 404 });
    },

    async receivedStudies(window: ReceivedWindow) {
      // 実の Orthanc と同じく、1 回に返す数に上限（MOCK_CHANGES_MAX）のある頁を、since・Last・Done で読む。
      // 遡り方（区切り・止め方・上限）は実の Orthanc と同じ collectReceivedInPeriod
      const all = parseChanges(await readJson<unknown>("made", "changes.json"));
      const read = await collectReceivedInPeriod(
        async (since, pageLimit) => {
          const part = all.changes.filter((c) => c.seq > since).slice(0, Math.min(pageLimit, MOCK_CHANGES_MAX));
          const last = part.at(-1)?.seq ?? since;
          return { changes: part, last, done: last >= all.last };
        },
        all.last,
        window,
        { block: 10, pageLimit: 1000, maxCalls: 200 },
      );
      const [studies, series, metadata] = await Promise.all([
        restStudies<RestStudy & { Series?: string[] }>(),
        readAll<RestSeries>("series"),
        readJson<Record<string, unknown>>("made", "instance-metadata.json"),
      ]);
      const received = read.ids.flatMap(({ id, date }): ReceivedStudy[] => {
        const study = studies.find((s) => s.ID === id || s.originalId === id);
        if (!study) return [];
        // Orthanc の /studies/{id}/series の形（検査のシリーズの順）
        const rows = (study.Series ?? []).flatMap((sid) => series.filter((s) => s.ID === sid));
        const { summary, instanceCount } = studyFromRest(study, rows);
        const first = firstInstanceId(rows);
        const reception = receptionFromMetadata(first ? metadata[first] : undefined);
        return [{ orthancId: study.ID, receivedAt: orthancTime(date), ...reception, instanceCount, stable: stableFromRest(study), summary }];
      });
      return { studies: received, overLimit: read.overLimit, complete: read.complete };
    },

    async listModalities() {
      return modalitiesFromRest(await readJson<unknown>("made", "modalities.json"));
    },

    async echoModality(modalityId: string) {
      const list = modalitiesFromRest(await readJson<unknown>("made", "modalities.json"));
      if (!list.some((m) => m.id === modalityId)) throw new BackendError("接続先が登録されていません", 404);
      return modalityId !== "offline";
    },

    async findStudiesByPatientId(patientId: string) {
      checkedPatientId(patientId);
      return (await restStudies()).filter((s) => s.PatientMainDicomTags.PatientID === patientId).map((s) => s.ID);
    },
    async studyPatient(id: string) {
      return studyPatientFromRest((await restStudies()).find((s) => s.ID === id));
    },
    async studyIsStable(id: string) {
      return (await restStudies()).some((s) => s.ID === id);
    },
    async studyInstanceTags(id: string) {
      const patient = await this.studyPatient(id);
      if (!patient) {
        return [];
      }
      const overrides = hl7Instances.get(patient.StudyInstanceUID);
      if (overrides) {
        return overrides.map(p => ({ ...p }));
      }
      const result: import("./types").PatientInstance[] = [];
      for (const series of await this.searchSeries(patient.StudyInstanceUID))
        for (const instance of await this.searchInstances(patient.StudyInstanceUID, series.seriesInstanceUid))
          result.push({
            ...patient,
            SeriesInstanceUID: series.seriesInstanceUid,
            SOPInstanceUID: instance.sopInstanceUid,
            SpecificCharacterSet: "ISO_IR 192"
          });
      return result;
    },
    // モックは検査を 1 件ずつしか持たないので、患者 ID が変わると元の検査を残さず新しい ID へ移す（元の画像を名指しで
    // 消した後の形）。後の deleteStudyInstances は、元の検査がもう無いので何もしない
    async modifyStudyKeepingUids(id: string, replace: Record<string, string>) {
      // 実の Orthanc と同じく、OverwriteInstances が無ければ仕事を作らずに 400 で断る（2026-10-25 に実測）
      if (hl7Simulation.noOverwriteInstances) {
        throw new BackendError("画像サーバーが書き換えを断りました（400）。Orthanc の OverwriteInstances が要る", 400);
      }
      const study = (await restStudies()).find((s) => s.ID === id);
      if (!study) {
        throw new BackendError("検査が見つかりません", 404);
      }
      const uid = study.MainDicomTags.StudyInstanceUID!;
      const before = await this.studyInstanceTags(id);
      const patientId = replace.PatientID ?? study.PatientMainDicomTags.PatientID;
      const patientChanged = patientId !== study.PatientMainDicomTags.PatientID;
      // Orthanc の ID の形（16 進 40 字を 8 字ずつ 5 つ）にそろえる。SHA-256 の先頭の 40 字を使う
      const newId = patientChanged
        ? createHash("sha256").update(`${uid}:${patientId}`).digest("hex").slice(0, 40).match(/.{8}/g)!.join("-") : id;
      mockTest.revision++;
      mockUpdates.set(uid, { id: newId, replace: { ...mockUpdates.get(uid)?.replace, ...replace } });
      const jobId = crypto.randomUUID();
      const state = hl7Simulation.state ?? "Success";
      // 失敗を再現した後の成功でも、前回の画像ごとの値を残さない。
      const changedCount = hl7Simulation.changedInstances ?? (state === "Failure" ? 0 : before.length);
      hl7Instances.set(uid, before.map((instance, index) =>
        index < changedCount ? { ...instance, ...replace } : instance));
      hl7Jobs.set(jobId, { state });
      if (hl7Simulation.dispatchTimeout) {
        throw new BackendUnknownError();
      }
      return { jobId };
    },
    async keepUidSettings() {
      return { overwriteInstances: !hl7Simulation.noOverwriteInstances, lockMetadata: !hl7Simulation.lockRefused };
    },
    // 中身の訂正：元の検査を残し、新しい UID の検査を足す（仕事は書き換えと同じく、試験から状態を差し替えられる）
    async modifyStudyNewUid(id: string, replace: Record<string, string>) {
      const study = (await restStudies()).find((s) => s.ID === id);
      if (!study) {
        throw new BackendError("検査が見つかりません", 404);
      }
      const { StudyInstanceUID: uid, ...values } = replace;
      if (!uid || mockCopies.has(uid)) {
        throw new BackendError("新しい StudyInstanceUID が正しくありません", 400);
      }
      const jobId = crypto.randomUUID();
      const state = hl7Simulation.state ?? "Success";
      if (state !== "Failure") {
        mockTest.revision++;
        const newId = createHash("sha256").update(`copy:${uid}`).digest("hex").slice(0, 40).match(/.{8}/g)!.join("-");
        mockCopies.set(uid, { id: newId, sourceUid: study.MainDicomTags.StudyInstanceUID!, replace: values });
      }
      hl7Jobs.set(jobId, { state });
      if (hl7Simulation.dispatchTimeout) {
        throw new BackendUnknownError();
      }
      return { jobId };
    },
    // モックは画像のファイルを持たないので、印は SOP の UID から作る。届き直しは無い
    async studyInstanceFiles(id: string) {
      const list = await this.studyInstanceTags(id);
      const key = (i: (typeof list)[number]) => [i.StudyInstanceUID, i.SeriesInstanceUID, i.SOPInstanceUID].join("|");
      return {
        since: 0,
        files: Object.fromEntries(list.map((i) => [key(i), `mock-file-${i.SOPInstanceUID}`])),
        ids: Object.fromEntries(list.map((i) => [key(i), mockInstanceId(key(i))])),
      };
    },
    async deleteStudyInstances(id: string) {
      if ((await restStudies()).some((s) => s.ID === id)) {
        throw new BackendError("モック：書き換えの元の検査が残っている");
      }
    },
    async lockStudy(id: string, untilEpochSeconds: number) {
      if (hl7Simulation.lockRefused) {
        throw new BackendError("画像サーバーが付け替えの印を断りました（404）。Orthanc の UserMetadata に TsunagiLock が要る");
      }
      hl7Locks.set(id, untilEpochSeconds);
      hl7LockLog.push(`lock:${id}`);
    },
    // モックは BFF と同じ時計
    async checkLockClock() {},
    async unlockStudy(id: string) {
      hl7Locks.delete(id);
      hl7LockLog.push(`unlock:${id}`);
    },
    // モックの書き換えは検査ごと移すので、どの画像も元の画像の写しとして答える（foreignCopies で、写しでない形にする）
    async studyInstanceOrigins(id: string) {
      const key = (i: import("./types").PatientInstance) => [i.StudyInstanceUID, i.SeriesInstanceUID, i.SOPInstanceUID].join("|");
      return Object.fromEntries((await this.studyInstanceTags(id)).map((i) =>
        [key(i), hl7Simulation.foreignCopies ? null : mockInstanceId(key(i))]));
    },

    async lookupStudyIds(studyInstanceUid: string) {
      const studies = await restStudies();
      const ids = studies.filter((s) => s.MainDicomTags.StudyInstanceUID === studyInstanceUid).map((s) => s.ID);
      return [...ids, ...(mockTest.extraIds.get(studyInstanceUid) ?? [])];
    },

    async lookupStudy(studyInstanceUid: string) {
      return singleStudyId(await this.lookupStudyIds(studyInstanceUid));
    },

    async studyInfo(orthancStudyId: string) {
      const study = (await restStudies<RestStudy & { LastUpdate?: string }>()).find((s) => s.ID === orthancStudyId);
      if (!study) return null;
      const info = studyInfoFromRest(study);
      return info && { ...info, version: mockTest.versions.get(orthancStudyId) ?? info.version };
    },

    async sendStudy(modalityId: string, orthancStudyId: string) {
      const list = modalitiesFromRest(await readJson<unknown>("made", "modalities.json"));
      if (!list.some((m) => m.id === modalityId)) throw new BackendError("接続先が登録されていません", 404);
      if (!isOrthancId(orthancStudyId)) throw new BackendError("検査の ID が正しくありません", 400);
      const id = randomUUID();
      mockJobs.set(id, { id, modality: modalityId, study: orthancStudyId, reads: 0, creationTime: orthancNow() });
      return { jobId: id };
    },

    async unfinishedModifyJobs() {
      return [...hl7Jobs.values()].filter((j) => j.state !== "Success" && j.state !== "Failure").length;
    },

    async jobStatus(jobId: string) {
      const hl7 = hl7Jobs.get(jobId);
      if (hl7) {
        return {
          id: jobId,
          state: hl7.state,
          progress: hl7.state === "Running" ? 50 : 100,
          errorCode: 0,
          errorDescription: "",
          creationTime: orthancNow(),
          completionTime: null
        };
      }
      const job = mockJobs.get(jobId);
      if (!job) {
        return null;
      }
      job.reads += 1;
      const failed = job.modality === "offline";
      const state = job.reads <= 1 ? "Pending" : job.reads === 2 ? "Running" : failed ? "Failure" : "Success";
      const done = state === "Success" || state === "Failure";
      return jobFromRest({
        ID: job.id,
        State: state,
        Progress: state === "Pending" ? 0 : state === "Running" ? 50 : 100,
        ErrorCode: state === "Failure" ? 9 : 0,
        ErrorDescription: state === "Failure" ? "Error in the network protocol" : "Success",
        CreationTime: job.creationTime,
        CompletionTime: done ? orthancNow() : "",
        Type: "DicomModalityStore",
      });
    },

    async exportStudy(orthancStudyId: string) {
      const study = (await restStudies()).find((s) => s.ID === orthancStudyId);
      if (!study) throw new BackendError("検査が見つかりません", 404);
      const text = `モックの書き出し（画像の本体は入っていない）\nStudyInstanceUID: ${study.MainDicomTags.StudyInstanceUID ?? ""}\n`;
      return new Response(mockZip("README.txt", text), { status: 200, headers: { "content-type": "application/zip" } });
    },

    async deleteStudy(orthancStudyId: string) {
      const study = (await restStudies()).find((s) => s.ID === orthancStudyId);
      if (!study) throw new BackendError("検査が見つかりません", 404);
      mockDeleted.add(study.MainDicomTags.StudyInstanceUID ?? "");
    },

    // 段 6：インポート。モックは画像の本体を持たないので、見本の検査（消した検査を含む）の StudyInstanceUID のファイルだけを受け、
    // その検査を出し直す（消した検査を入れ直す形）。ほかの検査のファイルは、Orthanc が受けなかった形（BackendError）にする
    async importInstance(file: Uint8Array) {
      const header = readDicomFileHeader(file);
      const study = (await readAll<RestStudy>("studies")).find((s) => s.MainDicomTags.StudyInstanceUID === header.studyInstanceUid);
      if (!study || mockImport.refuse) throw new BackendError("画像サーバーがファイルを受け付けませんでした");
      const known = mockImported.instances.has(header.sopInstanceUid) && !mockDeleted.has(header.studyInstanceUid);
      mockDeleted.delete(header.studyInstanceUid);
      mockImported.instances.set(header.sopInstanceUid, study.ID);
      if (mockImport.unknown) throw new BackendUnknownError();
      return {
        status: known ? ("AlreadyStored" as const) : ("Success" as const),
        instanceId: mockInstanceId(header.sopInstanceUid),
        orthancStudyId: study.ID,
      };
    },

    async labelImported(orthancStudyId: string) {
      const study = (await restStudies()).find((s) => s.ID === orthancStudyId);
      if (!study) throw new BackendError("検査が見つかりません", 404);
      mockImported.labels.add(study.MainDicomTags.StudyInstanceUID ?? "");
    },

    async importedStudyUids() {
      const present = new Set((await restStudies()).map((s) => s.MainDicomTags.StudyInstanceUID ?? ""));
      return new Set([...mockImported.labels].filter((uid) => present.has(uid)));
    },

    async findInstanceStudy(sopInstanceUid: string) {
      const id = mockImported.instances.get(sopInstanceUid);
      if (!id) return null;
      return (await restStudies()).some((s) => s.ID === id) ? { instanceId: mockInstanceId(sopInstanceUid), orthancStudyId: id } : null;
    },

    // 入れた画像を消す。検査の入れた画像が無くなれば、検査を消した形に戻す（モックの検査は、入れた画像だけでできている）
    async deleteImportedInstance(instanceId: string) {
      const sop = [...mockImported.instances.keys()].find((uid) => mockInstanceId(uid) === instanceId);
      const studyId = sop ? mockImported.instances.get(sop) : undefined;
      const study = studyId ? (await restStudies()).find((s) => s.ID === studyId) : undefined;
      if (!sop || !study) throw new BackendError("画像が見つかりません", 404);
      if (mockImport.deleteUnknown) throw new BackendUnknownError();
      mockImported.instances.delete(sop);
      if (![...mockImported.instances.values()].includes(study.ID)) mockDeleted.add(study.MainDicomTags.StudyInstanceUID ?? "");
    },

    async instanceExists(instanceId: string) {
      const sop = [...mockImported.instances.keys()].find((uid) => mockInstanceId(uid) === instanceId);
      const studyId = sop ? mockImported.instances.get(sop) : undefined;
      return studyId !== undefined && (await restStudies()).some((s) => s.ID === studyId);
    },

    // モックの検査は、入れた画像だけでできている。消していない見本の検査は、見本の画像（合成の UID）を持つ形にする
    async studyInstanceSopUids(orthancStudyId: string) {
      const study = (await restStudies()).find((s) => s.ID === orthancStudyId);
      if (!study) return [];
      const imported = [...mockImported.instances].filter(([, id]) => id === orthancStudyId).map(([sop]) => sop);
      return imported.length > 0 ? imported : [syntheticUid(orthancStudyId)];
    },
  };
}

/** モックのインポート：入れた画像（SOP Instance UID → 検査の ID）と、印（ラベル）を付けた検査の StudyInstanceUID */
const IMPORTED_KEY = Symbol.for("tsunagi-dicom.mock-imported");
const importedHolder = globalThis as typeof globalThis & {
  [IMPORTED_KEY]?: { instances: Map<string, string>; labels: Set<string> };
};
const mockImported = (importedHolder[IMPORTED_KEY] ??= { instances: new Map(), labels: new Set() });
let mockImport: { unknown?: boolean; refuse?: boolean; deleteUnknown?: boolean } = {};
/**
 * 試験のため：次からのインポートを、入れた後に答えが分からない形・Orthanc が受けない形にする。deleteUnknown は、入れた画像を
 * 消す答えが分からない形（空で戻す）
 */
export function simulateMockImport(options: typeof mockImport): void {
  mockImport = { ...options };
}

// テストから仕事の終了・失敗・時間切れを再現する。画像ごとの応答も差し替えられる。
export const hl7Jobs = new Map<string, {
  state: import("./types").JobState;
}>();

const hl7Instances = new Map<string, import("./types").PatientInstance[]>();
/** 付け替えの印（検査の ID → 期限の UNIX 秒）と、付けた・外した順の記録（試験が読む） */
export const hl7Locks = new Map<string, number>();
export const hl7LockLog: string[] = [];
let hl7Simulation: {
  state?: import("./types").JobState;
  changedInstances?: number;
  dispatchTimeout?: boolean;
  /** 付け替えの印を断る（Orthanc に UserMetadata が無いときの形） */
  lockRefused?: boolean;
  /** 写しの ModifiedFrom が元の画像の ID と合わない（写しが別の画像に置き換わった形） */
  foreignCopies?: boolean;
  /** Orthanc に OverwriteInstances が無い形（UID を保つ書き換えに要る設定が無い） */
  noOverwriteInstances?: boolean;
} = {};
/** 次の書き換えを、動き続ける仕事・失敗・一部だけの変更・応答の時間切れにする。 */
export function simulateMockHl7(options: typeof hl7Simulation): void {
  hl7Simulation = { ...options };
}
