import "server-only";
import { getCACertificates } from "node:tls";
import { Agent, fetch, type Dispatcher } from "undici";
import { sortStudiesNewestFirst, studyFromDicomJson, type DicomJsonDataset } from "@/lib/backend/dicom-json";
import { wadoRsTarget } from "@/lib/backend/relay-path";
import { BackendError, clampStudyLimit, STUDY_LIMIT, type Backend, type RelayRequest } from "@/lib/backend/types";
import type { AppConfig } from "@/lib/config";

// 実の画像サーバーへの接続。資格情報はここだけで使う。
// 証明書は必ず確かめる。BACKEND_CA_FILE があれば、Node の既定の CA（NODE_EXTRA_CA_CERTS を含む）に足して使う。
// 確かめを切る道は作らない。

const TIMEOUT_MS = 15_000;
const MAX_SEARCH_LENGTH = 2048;

/**
 * 中継で、画像サーバーの応答からブラウザへ渡してよいヘッダー。
 * content-length と content-encoding は渡さない：fetch は圧縮の応答をほどいて渡すので、
 * 画像サーバーの長さ（圧縮の後の長さ）と本文の長さが合わなくなる。長さは Next.js の側で付け直す
 */
const PASS_HEADERS = ["content-type", "content-disposition", "etag", "last-modified"];

export function createHttpBackend(config: AppConfig["backend"]): Backend {
  const { kind, dicomwebUrl, orthancUrl, username, password, caPem } = config;
  if (!dicomwebUrl) throw new BackendError("BACKEND_DICOMWEB_URL が無い", 500);

  const dispatcher: Dispatcher | undefined = caPem
    ? new Agent({ connect: { ca: [...getCACertificates("default"), caPem] } })
    : undefined;
  const authorization =
    username && password ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` : undefined;

  async function call(base: string, path: string, init: { method?: "GET" | "HEAD"; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...init.headers };
    if (authorization) headers.authorization = authorization;
    try {
      return await fetch(`${base.replace(/\/+$/, "")}/${path}`, {
        method: init.method ?? "GET",
        headers,
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // 原因の文言に URL や資格情報が入りうるので、ブラウザへは渡さない
      throw new BackendError("画像サーバーにつながらない");
    }
  }

  async function getJson<T>(base: string, path: string): Promise<T> {
    const res = await call(base, path, { headers: { accept: "application/dicom+json, application/json" } });
    if (res.status === 204) return [] as T;
    if (!res.ok) throw new BackendError(`画像サーバーの応答が ${res.status}`);
    return (await res.json()) as T;
  }

  async function qidoStudies(limit: number) {
    const query = new URLSearchParams({ limit: String(clampStudyLimit(limit)) });
    // 既定で返らないことがある項目を求める
    query.append("includefield", "00081030");
    query.append("includefield", "00080061");
    query.append("includefield", "00201206");
    query.append("includefield", "00201208");
    return getJson<DicomJsonDataset[]>(dicomwebUrl!, `studies?${query}`);
  }

  return {
    kind,
    mock: false,

    async searchStudies(limit = STUDY_LIMIT) {
      return sortStudiesNewestFirst((await qidoStudies(limit)).map(studyFromDicomJson));
    },

    async countStudies() {
      if (kind === "orthanc" && orthancUrl) {
        const stats = await getJson<{ CountStudies: number }>(orthancUrl, "statistics");
        return { count: stats.CountStudies, exact: true };
      }
      const studies = await qidoStudies(STUDY_LIMIT);
      return { count: studies.length, exact: studies.length < STUDY_LIMIT };
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
  };
}
