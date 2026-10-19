import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { crc32 } from "node:zlib";
import {
  firstInstanceId,
  isOrthancId,
  jobFromRest,
  modalitiesFromRest,
  orthancTime,
  parseChanges,
  receivedStudyIds,
  receptionFromMetadata,
  studyFromRest,
} from "@/lib/backend/orthanc-rest";
import {
  inDateRange,
  sortSeries,
  sortStudiesNewestFirst,
  stringValue,
  studyFromDicomJson,
  TAG,
  type DicomJsonDataset,
} from "@/lib/backend/dicom-json";
import { wadoRsTarget } from "@/lib/backend/relay-path";
import {
  BackendError,
  clampStudyLimit,
  STUDY_LIMIT,
  type Backend,
  type ReceivedStudy,
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

const orthancNow = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");

/** モックで消した検査（StudyInstanceUID。段 5）。このプロセスの記憶の中だけで、見本のファイルは変えない */
const DELETED_KEY = Symbol.for("tsunagi-dicom.mock-deleted");
const deletedHolder = globalThis as typeof globalThis & { [DELETED_KEY]?: Set<string> };
const mockDeleted = (deletedHolder[DELETED_KEY] ??= new Set<string>());

/** 試験のため：モックで消した検査を戻す */
export function restoreMockStudies(): void {
  mockDeleted.clear();
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
  MainDicomTags: { StudyInstanceUID?: string };
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
  MainDicomTags: { SOPInstanceUID?: string };
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
  file: string;
}

export function createMockBackend(): Backend {
  // 消した検査は、どの読み取りにも出さない
  const qidoStudies = async () =>
    (await readJson<DicomJsonDataset[]>("dicom-web", "studies.json")).filter(
      (ds) => !mockDeleted.has(stringValue(ds, TAG.StudyInstanceUID)),
    );
  const restStudies = async <T extends RestStudy>() =>
    (await readAll<T>("studies")).filter((s) => !mockDeleted.has(s.MainDicomTags.StudyInstanceUID ?? ""));

  async function restSeriesByStudy(): Promise<Map<string, RestSeries[]>> {
    const [studies, series] = await Promise.all([restStudies(), readAll<RestSeries>("series")]);
    const uidById = new Map(studies.map((s) => [s.ID, s.MainDicomTags.StudyInstanceUID ?? ""]));
    const out = new Map<string, RestSeries[]>();
    for (const s of series) {
      const uid = uidById.get(s.ParentStudy);
      if (!uid) continue;
      out.set(uid, [...(out.get(uid) ?? []), s]);
    }
    return out;
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
      const studies = (await qidoStudies()).map(studyFromDicomJson).filter((s) => inDateRange(s.studyDate, query));
      return sortStudiesNewestFirst(studies).slice(0, clampStudyLimit(limit));
    },

    async countStudies() {
      const stats = await readJson<{ CountStudies: number }>("rest", "statistics.json");
      return { count: stats.CountStudies - mockDeleted.size, exact: true };
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

    async relayDicomweb(req: RelayRequest) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new BackendError("中継は読み取りだけ", 405);
      const target = wadoRsTarget(req.target.path.split("/"));
      if (!target || target.path !== req.target.path) throw new BackendError("中継は WADO-RS の読み取りだけ", 404);

      const last = target.path.split("/").at(-1);
      if (last === "thumbnail" || last === "rendered") {
        const image = (await previews()).find(
          (p) =>
            p.studyInstanceUid === target.studyInstanceUid &&
            (!target.seriesInstanceUid || p.seriesInstanceUid === target.seriesInstanceUid) &&
            (!target.sopInstanceUid || p.sopInstanceUid === target.sopInstanceUid),
        );
        if (image) {
          const body = await readFile(image.file);
          return new Response(req.method === "HEAD" ? null : body, { status: 200, headers: { "content-type": "image/png" } });
        }
      }
      return Response.json({ error: "見本に無い" }, { status: 404 });
    },

    async receivedStudies(limit: number) {
      const changes = parseChanges(await readJson<unknown>("made", "changes.json")).changes;
      const [studies, series, metadata] = await Promise.all([
        restStudies<RestStudy & { Series?: string[] }>(),
        readAll<RestSeries>("series"),
        readJson<Record<string, unknown>>("made", "instance-metadata.json"),
      ]);
      return receivedStudyIds(changes, limit).flatMap(({ id, date }): ReceivedStudy[] => {
        const study = studies.find((s) => s.ID === id);
        if (!study) return [];
        // Orthanc の /studies/{id}/series の形（検査のシリーズの順）
        const rows = (study.Series ?? []).flatMap((sid) => series.filter((s) => s.ID === sid));
        const { summary, instanceCount } = studyFromRest(study, rows);
        const first = firstInstanceId(rows);
        const reception = receptionFromMetadata(first ? metadata[first] : undefined);
        return [{ orthancId: id, receivedAt: orthancTime(date), ...reception, instanceCount, summary }];
      });
    },

    async listModalities() {
      return modalitiesFromRest(await readJson<unknown>("made", "modalities.json"));
    },

    async echoModality(modalityId: string) {
      const list = modalitiesFromRest(await readJson<unknown>("made", "modalities.json"));
      if (!list.some((m) => m.id === modalityId)) throw new BackendError("機器が登録されていない", 404);
      return modalityId !== "offline";
    },

    async lookupStudy(studyInstanceUid: string) {
      const studies = await restStudies();
      return studies.find((s) => s.MainDicomTags.StudyInstanceUID === studyInstanceUid)?.ID ?? null;
    },

    async sendStudy(modalityId: string, orthancStudyId: string) {
      const list = modalitiesFromRest(await readJson<unknown>("made", "modalities.json"));
      if (!list.some((m) => m.id === modalityId)) throw new BackendError("機器が登録されていない", 404);
      if (!isOrthancId(orthancStudyId)) throw new BackendError("検査の ID の形が誤り", 400);
      const id = randomUUID();
      mockJobs.set(id, { id, modality: modalityId, study: orthancStudyId, reads: 0, creationTime: orthancNow() });
      return { jobId: id };
    },

    async jobStatus(jobId: string) {
      const job = mockJobs.get(jobId);
      if (!job) return null;
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
      if (!study) throw new BackendError("検査が見つからない", 404);
      const text = `モックの書き出し（画像の本体は入っていない）\nStudyInstanceUID: ${study.MainDicomTags.StudyInstanceUID ?? ""}\n`;
      return new Response(mockZip("README.txt", text), { status: 200, headers: { "content-type": "application/zip" } });
    },

    async deleteStudy(orthancStudyId: string) {
      const study = (await restStudies()).find((s) => s.ID === orthancStudyId);
      if (!study) throw new BackendError("検査が見つからない", 404);
      mockDeleted.add(study.MainDicomTags.StudyInstanceUID ?? "");
    },
  };
}
