import { readFile } from "node:fs/promises";
import path from "node:path";
import { sortStudiesNewestFirst, studyFromDicomJson, type DicomJsonDataset } from "@/lib/backend/dicom-json";
import { wadoRsTarget } from "@/lib/backend/relay-path";
import { BackendError, clampStudyLimit, STUDY_LIMIT, type Backend, type RelayRequest } from "@/lib/backend/types";

// モックのバックエンド（BACKEND_MOCK=true）。tests/fixtures/orthanc の合成の見本を返す。
// 中継（WADO-RS の読み取り）の見本はまだ無いので、中継は宛先を確かめたうえで 404 を返す。

export function fixturesDir(): string {
  return path.join(process.cwd(), "tests", "fixtures", "orthanc");
}

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDir(), ...parts), "utf8")) as T;
}

export function createMockBackend(kind: "orthanc" | "dicomweb"): Backend {
  const qidoStudies = () => readJson<DicomJsonDataset[]>("dicom-web", "studies.json");

  return {
    kind,
    mock: true,

    async searchStudies(limit = STUDY_LIMIT) {
      return sortStudiesNewestFirst((await qidoStudies()).map(studyFromDicomJson)).slice(0, clampStudyLimit(limit));
    },

    async countStudies() {
      if (kind === "orthanc") {
        const stats = await readJson<{ CountStudies: number }>("rest", "statistics.json");
        return { count: stats.CountStudies, exact: true };
      }
      const studies = await qidoStudies();
      return { count: studies.length, exact: studies.length < STUDY_LIMIT };
    },

    async relayDicomweb(req: RelayRequest) {
      if (req.method !== "GET" && req.method !== "HEAD") throw new BackendError("中継は読み取りだけ", 405);
      const target = wadoRsTarget(req.target.path.split("/"));
      if (!target || target.path !== req.target.path) throw new BackendError("中継は WADO-RS の読み取りだけ", 404);
      return Response.json({ error: "見本に無い" }, { status: 404 });
    },
  };
}
