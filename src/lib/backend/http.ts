import "server-only";
import { getCACertificates } from "node:tls";
import { Agent, fetch, type Dispatcher } from "undici";
import {
  inDateRange,
  seriesFromDicomJson,
  sortSeries,
  sortStudiesNewestFirst,
  stringValue,
  studyDateRange,
  studyFromDicomJson,
  TAG,
  type DicomJsonDataset,
} from "@/lib/backend/dicom-json";
import {
  firstInstanceId,
  isJobId,
  isModalityName,
  isOrthancId,
  jobFromRest,
  modalitiesFromRest,
  orthancTime,
  parseChanges,
  receivedStudyIds,
  receptionFromMetadata,
  studyFromRest,
  type OrthancChange,
} from "@/lib/backend/orthanc-rest";
import { isDicomUid, wadoRsTarget } from "@/lib/backend/relay-path";
import {
  BackendError,
  BackendUnknownError,
  clampStudyLimit,
  STUDY_LIMIT,
  type Backend,
  type ReceivedStudy,
  type RelayRequest,
  type StudyQuery,
} from "@/lib/backend/types";
import type { AppConfig } from "@/lib/config";

// 実の Orthanc への接続（Orthanc 専用。docs/spec.md の 0）。検索と中継は Orthanc の DICOMweb のプラグイン、
// 件数は Orthanc の REST を使う。資格情報はここだけで使う。
// 証明書は必ず確かめる。BACKEND_CA_FILE があれば、Node の既定の CA（NODE_EXTRA_CA_CERTS を含む）に足して使う。
// 確かめを切る道は作らない。

const TIMEOUT_MS = 15_000;
/** 書き込みの操作の答えを待つ時間。過ぎたら結果不明（docs/spec.md の 3.5） */
const POST_TIMEOUT_MS = 30_000;
const MAX_SEARCH_LENGTH = 2048;
/**
 * 受け取りの記録のために、変更の記録をさかのぼって読む数（1 回 100 件、最大 50 回＝5000 件）。
 * 1 回の数は、Orthanc が切り詰めうる上限より小さくする（Orthanc の版で実測して確かめる。docs/round-trip-test.md）
 */
const CHANGES_PAGE = 100;
const CHANGES_PAGES = 50;
/** 受け取った検査を組み立てるときに、同時に Orthanc へ求める数 */
const RECEIVED_PARALLEL = 8;

/**
 * 中継で、画像サーバーの応答からブラウザへ渡してよいヘッダー。
 * content-length と content-encoding は渡さない：fetch は圧縮の応答をほどいて渡すので、
 * 画像サーバーの長さ（圧縮の後の長さ）と本文の長さが合わなくなる。長さは Next.js の側で付け直す
 */
const PASS_HEADERS = ["content-type", "content-disposition", "etag", "last-modified"];

export function createHttpBackend(config: AppConfig["backend"]): Backend {
  const { dicomwebUrl, orthancUrl, username, password, writeUsername, writePassword, caPem } = config;
  if (!dicomwebUrl) throw new BackendError("BACKEND_DICOMWEB_URL が無い", 500);
  if (!orthancUrl) throw new BackendError("BACKEND_ORTHANC_URL が無い", 500);

  const dispatcher: Dispatcher | undefined = caPem
    ? new Agent({ connect: { ca: [...getCACertificates("default"), caPem] } })
    : undefined;
  const basic = (user?: string, pass?: string) =>
    user && pass ? `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` : undefined;
  const authorization = basic(username, password);
  // 書き込みの操作（POST）は、書く資格情報があればそれで、無ければ読む資格情報で（docs/security-and-maintenance.md の 4.1）
  const writeAuthorization = basic(writeUsername, writePassword) ?? authorization;

  async function call(
    base: string,
    path: string,
    init: {
      method?: "GET" | "HEAD" | "POST";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
      /** 書き込みの操作：送った後に答えが来なければ、届いたかが分からない（結果不明） */
      write?: boolean;
      /** どの資格情報で求めるか。既定は GET・HEAD が読む資格情報、POST が書く資格情報 */
      credential?: "read" | "write";
    } = {},
  ) {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { ...init.headers };
    const auth = (init.credential ?? (method === "POST" ? "write" : "read")) === "write" ? writeAuthorization : authorization;
    if (auth) headers.authorization = auth;
    try {
      return await fetch(`${base.replace(/\/+$/, "")}/${path}`, {
        method,
        headers,
        body: init.body,
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      // 原因の文言に URL や資格情報が入りうるので、ブラウザへは渡さない
      if (init.write) throw new BackendUnknownError();
      throw new BackendError("画像サーバーにつながらない");
    }
  }

  /** Orthanc の REST の JSON。見つからなければ null（消された検査など） */
  async function restJsonOrNull(path: string): Promise<unknown> {
    const res = await call(orthancUrl!, path, { headers: { accept: "application/json" } });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new BackendError(`画像サーバーの応答が ${res.status}`);
    }
    return res.json();
  }

  /**
   * Orthanc の REST へ POST。本文は JSON の文字列。既定は書く資格情報（C-ECHO・送る）。
   * 引き当て（/tools/lookup）は Orthanc の中身を変えない読み取りなので、読む資格情報で求める（credential: "read"）
   */
  async function restPost(
    path: string,
    body: string,
    options: { contentType?: string; write?: boolean; credential?: "read" | "write" } = {},
  ) {
    return call(orthancUrl!, path, {
      method: "POST",
      headers: { accept: "application/json", "content-type": options.contentType ?? "application/json" },
      body,
      timeoutMs: POST_TIMEOUT_MS,
      write: options.write,
      credential: options.credential,
    });
  }

  /** 受け取った1件の検査を組み立てる。消されていれば null */
  async function receivedOne(id: string, date: string): Promise<ReceivedStudy | null> {
    const [study, series] = await Promise.all([restJsonOrNull(`studies/${id}`), restJsonOrNull(`studies/${id}/series`)]);
    if (!study || !Array.isArray(series)) return null;
    const { summary, instanceCount } = studyFromRest(study, series);
    const first = firstInstanceId(series);
    const reception = first ? receptionFromMetadata(await restJsonOrNull(`instances/${first}/metadata?expand`)) : null;
    return {
      orthancId: id,
      receivedAt: orthancTime(date),
      remoteAet: reception?.remoteAet ?? null,
      origin: reception?.origin ?? null,
      instanceCount,
      summary,
    };
  }

  async function getJson<T>(base: string, path: string): Promise<T> {
    const res = await call(base, path, { headers: { accept: "application/dicom+json, application/json" } });
    if (res.status === 204) return [] as T;
    if (!res.ok) throw new BackendError(`画像サーバーの応答が ${res.status}`);
    return (await res.json()) as T;
  }

  async function qidoStudies(limit: number, studyQuery?: StudyQuery) {
    const query = new URLSearchParams({ limit: String(clampStudyLimit(limit)) });
    const range = studyDateRange(studyQuery);
    if (range) query.set("StudyDate", range);
    // 既定で返らないことがある項目を求める
    query.append("includefield", "00081030");
    query.append("includefield", "00080061");
    query.append("includefield", "00201206");
    query.append("includefield", "00201208");
    return getJson<DicomJsonDataset[]>(dicomwebUrl!, `studies?${query}`);
  }

  /** UID は字を確かめてから URL に入れる（画像サーバーの path の外へ出さない） */
  function checkedUid(uid: string): string {
    if (!isDicomUid(uid)) throw new BackendError("StudyInstanceUID の形が誤り", 400);
    return uid;
  }

  return {
    kind: "orthanc",
    mock: false,

    async searchStudies(limit = STUDY_LIMIT, query?: StudyQuery) {
      // 範囲は画像サーバーで絞るが、答えをそのまま信じず、ここでも確かめる
      const studies = (await qidoStudies(limit, query)).map(studyFromDicomJson).filter((s) => inDateRange(s.studyDate, query));
      return sortStudiesNewestFirst(studies);
    },

    async searchSeries(studyInstanceUid: string) {
      const query = new URLSearchParams();
      query.append("includefield", TAG.SeriesDescription);
      query.append("includefield", TAG.BodyPartExamined);
      query.append("includefield", TAG.NumberOfSeriesRelatedInstances);
      query.append("includefield", TAG.SeriesDate);
      const rows = await getJson<DicomJsonDataset[]>(
        dicomwebUrl!,
        `studies/${checkedUid(studyInstanceUid)}/series?${query}`,
      );
      return sortSeries(Array.isArray(rows) ? rows.map(seriesFromDicomJson) : []);
    },

    async studyDataset(studyInstanceUid: string) {
      const query = new URLSearchParams({ StudyInstanceUID: checkedUid(studyInstanceUid), includefield: "all", limit: "1" });
      const rows = await getJson<DicomJsonDataset[]>(dicomwebUrl!, `studies?${query}`);
      if (!Array.isArray(rows)) return null;
      return rows.find((ds) => stringValue(ds, TAG.StudyInstanceUID) === studyInstanceUid) ?? null;
    },

    async countStudies() {
      const stats = await getJson<{ CountStudies: number }>(orthancUrl, "statistics");
      return { count: stats.CountStudies, exact: true };
    },

    async relayDicomweb(req: RelayRequest) {
      // 呼ぶ側でも確かめるが、ここでも読み取りの WADO-RS だけにする（二重の確かめ）
      if (req.method !== "GET" && req.method !== "HEAD") throw new BackendError("中継は読み取りだけ", 405);
      const target = wadoRsTarget(req.target.path.split("/"));
      if (!target || target.path !== req.target.path) throw new BackendError("中継は WADO-RS の読み取りだけ", 404);
      if (req.search !== "" && (!req.search.startsWith("?") || req.search.length > MAX_SEARCH_LENGTH)) {
        throw new BackendError("query が長すぎるか、形が誤り", 400);
      }

      const headers: Record<string, string> = {};
      if (req.accept) headers.accept = req.accept;
      const res = await call(dicomwebUrl!, `${target.path}${req.search}`, { method: req.method, headers });
      // 画像サーバーの中の URL へ飛ばす応答は、ブラウザへそのまま渡さない
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel();
        return new Response(null, { status: 502 });
      }
      const out = new Headers();
      for (const name of PASS_HEADERS) {
        const v = res.headers.get(name);
        if (v) out.set(name, v);
      }
      return new Response(res.body as ReadableStream<Uint8Array> | null, { status: res.status, headers: out });
    },

    async receivedStudies(limit: number) {
      // 変更の記録の最後の番号から、新しい側を先に、1 頁ずつ古い側へさかのぼって読む。
      // Orthanc は 1 回に返す数を小さく切り詰めることがある（頁は CHANGES_PAGE 件。実測で確かめる）ので、
      // 頁ごとに since を後ろへ下げる。受け取りの検査が limit 件そろうか、決めた頁の数で止める
      const head = parseChanges(await restJsonOrNull("changes?last"));
      const changes: OrthancChange[] = [];
      for (let page = 0; page < CHANGES_PAGES; page++) {
        const upper = head.last - page * CHANGES_PAGE;
        if (upper <= 0) break;
        const since = Math.max(0, upper - CHANGES_PAGE);
        const part = parseChanges(
          await restJsonOrNull(`changes?${new URLSearchParams({ since: String(since), limit: String(CHANGES_PAGE) })}`),
        );
        changes.push(...part.changes.filter((c) => c.seq > since && c.seq <= upper));
        if (receivedStudyIds(changes, limit).length >= limit) break;
      }
      const ids = receivedStudyIds(changes, limit);
      const out: ReceivedStudy[] = [];
      for (let i = 0; i < ids.length; i += RECEIVED_PARALLEL) {
        const batch = await Promise.all(ids.slice(i, i + RECEIVED_PARALLEL).map((x) => receivedOne(x.id, x.date)));
        for (const r of batch) if (r) out.push(r);
      }
      return out;
    },

    async listModalities() {
      return modalitiesFromRest(await restJsonOrNull("modalities?expand"));
    },

    async echoModality(modalityId: string) {
      if (!isModalityName(modalityId)) throw new BackendError("機器の名前の形が誤り", 400);
      // Orthanc 1.7.0 からは、本文に JSON が要る
      const res = await restPost(`modalities/${encodeURIComponent(modalityId)}/echo`, JSON.stringify({ Timeout: 10 }));
      await res.body?.cancel();
      if (res.status === 404) throw new BackendError("機器が登録されていない", 404);
      if (res.ok) return true;
      // Orthanc は C-ECHO が通らないとき 500 を返す。ほか（資格情報の誤り・入口の誤りなど）は「つながらない」としない
      if (res.status === 500) return false;
      throw new BackendError(`画像サーバーの応答が ${res.status}`);
    },

    async lookupStudy(studyInstanceUid: string) {
      const res = await restPost("tools/lookup", checkedUid(studyInstanceUid), { contentType: "text/plain", credential: "read" });
      if (!res.ok) {
        await res.body?.cancel();
        throw new BackendError(`画像サーバーの応答が ${res.status}`);
      }
      const rows: unknown = await res.json();
      const hit = Array.isArray(rows)
        ? rows.find((r) => r && typeof r === "object" && (r as { Type?: unknown }).Type === "Study")
        : undefined;
      const id = hit ? (hit as { ID?: unknown }).ID : undefined;
      return isOrthancId(id) ? id : null;
    },

    async sendStudy(modalityId: string, orthancStudyId: string) {
      if (!isModalityName(modalityId)) throw new BackendError("機器の名前の形が誤り", 400);
      if (!isOrthancId(orthancStudyId)) throw new BackendError("検査の ID の形が誤り", 400);
      const res = await restPost(
        `modalities/${encodeURIComponent(modalityId)}/store`,
        JSON.stringify({ Resources: [orthancStudyId], Synchronous: false }),
        { write: true },
      );
      if (res.status === 404) {
        await res.body?.cancel();
        throw new BackendError("機器が登録されていない", 404);
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new BackendError(`画像サーバーの応答が ${res.status}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        // 受けたが答えを読めない：仕事ができたかが分からない
        throw new BackendUnknownError();
      }
      const jobId = body && typeof body === "object" ? (body as { ID?: unknown }).ID : undefined;
      if (!isJobId(jobId)) throw new BackendUnknownError();
      return { jobId };
    },

    async jobStatus(jobId: string) {
      if (!isJobId(jobId)) return null;
      const json = await restJsonOrNull(`jobs/${jobId}`);
      return json ? jobFromRest(json) : null;
    },
  };
}
