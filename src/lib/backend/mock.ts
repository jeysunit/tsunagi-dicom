import { readFile } from "node:fs/promises";
import path from "node:path";
import { sortStudiesNewestFirst, studyFromDicomJson, type DicomJsonDataset } from "@/lib/backend/dicom-json";
import { safeRelayPath } from "@/lib/backend/relay-path";
import { STUDY_LIMIT, type Backend, type RelayRequest } from "@/lib/backend/types";

// モックのバックエンド（BACKEND_MOCK=true）。tests/fixtures/orthanc の合成の見本を返す。
// 書き込みは受けない（中継の書き込みは 501）。

export function fixturesDir(): string {
  return path.join(process.cwd(), "tests", "fixtures", "orthanc");
}

async function readJson<T>(...parts: string[]): Promise<T> {
  return JSON.parse(await readFile(path.join(fixturesDir(), ...parts), "utf8")) as T;
}

const UID = /^[0-9.]+$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status === 200 ? "application/dicom+json" : "application/json" },
  });
}

export function createMockBackend(kind: "orthanc" | "dicomweb"): Backend {
  const qidoStudies = () => readJson<DicomJsonDataset[]>("dicom-web", "studies.json");

  return {
    kind,
    mock: true,

    async searchStudies(limit = STUDY_LIMIT) {
      return sortStudiesNewestFirst((await qidoStudies()).map(studyFromDicomJson)).slice(0, limit);
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
      safeRelayPath(req.segments);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return json({ error: "モックのバックエンドは書き込みを受けない" }, 501);
      }
      const [first, uid, third, ...rest] = req.segments;
      if (first === "studies" && uid === undefined) return json(await qidoStudies());
      if (first === "studies" && uid && UID.test(uid) && third === "series" && rest.length === 0) {
        try {
          return json(await readJson("dicom-web", "studies", uid, "series.json"));
        } catch {
          return json({ error: "見本に無い" }, 404);
        }
      }
      return json({ error: "見本に無い" }, 404);
    },
  };
}
