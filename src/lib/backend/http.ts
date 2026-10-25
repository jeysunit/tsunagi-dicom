import "server-only";
import { getCACertificates } from "node:tls";
import { Agent, fetch, type Dispatcher } from "undici";
import {
  instanceFromDicomJson,
  matchesStudyQuery,
  seriesFromDicomJson,
  sortInstances,
  sortSeries,
  stringValue,
  studyDateRange,
  studyFromDicomJson,
  studyQueryParams,
  TAG,
  type DicomJsonDataset,
} from "@/lib/backend/dicom-json";
import {
  checkedPatientId,
  studyPatientFromRest,
  firstInstanceId,
  isJobId,
  isModalityName,
  isOrthancId,
  jobFromRest,
  modalitiesFromRest,
  orthancTime,
  parseChanges,
  readChanges,
  receivedStudyIds,
  singleStudyId,
  studyIdsFromLookup,
  studyInfoFromRest,
  receptionFromMetadata,
  studyFromRest,
} from "@/lib/backend/orthanc-rest";
import { collectNewestStudies, todayForWindows, warnsMoreResults, type WindowAnswer } from "@/lib/backend/newest-studies";
import { isDicomUid, relayAccept, wadoRsTarget, withoutAcceptParam } from "@/lib/backend/relay-path";
import {
  BackendError,
  BackendUnknownError,
  clampStudyLimit,
  STUDY_LIMIT,
  type Backend,
  type InstanceSummary,
  type PatientInstance,
  type ReceivedStudy,
  type SourceFiles,
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
/** 書き出し（ZIP）の答えが始まるまでを待つ時間（Orthanc は ZIP を作ってから答えを始めることがある） */
const EXPORT_TIMEOUT_MS = 10 * 60_000;
/** 書き出しの本文を流す間、次の塊が来るまでを待つ時間（全体の長さでは切らない。大きな検査でも途中で切らない） */
const EXPORT_IDLE_MS = 2 * 60_000;
const MAX_SEARCH_LENGTH = 2048;
/** 付け替えの印の、Orthanc の利用者のメタデータの名前（deploy/orthanc/tsunagi-lock.lua と同じ。design.md §15.4） */
const LOCK_METADATA = "TsunagiLock";
/** 画像の UID の組（studyInstanceFiles の鍵） */
const instanceKey = (i: PatientInstance) => [i.StudyInstanceUID, i.SeriesInstanceUID, i.SOPInstanceUID].join("|");
/**
 * 書き込みの操作の答えのうち、Orthanc が受けなかったと確かめられないもの（docs/spec.md の 3.5 の結果不明）：
 * 手前の入口の 502・503・504（Orthanc が受けた後に、入口が待ちきれなかったことがある）と、移す答え（3xx）
 */
export const isUncertainStatus = (status: number) => status === 502 || status === 503 || status === 504 || (status >= 300 && status < 400);

/** 受け取りの記録のために、変更の記録を 1 回に求める数（Orthanc が切り詰めても、Last から続けて読む） */
const CHANGES_PAGE = 100;
/** 読む範囲（直近の変更の数）と、読む回数の上限（Orthanc が 1 回の数を切り詰めても範囲を読み切れるだけの回数） */
const CHANGES_WINDOW = 5000;
const CHANGES_MAX_CALLS = 200;
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
      method?: "GET" | "HEAD" | "POST" | "PUT" | "DELETE";
      headers?: Record<string, string>;
      body?: string;
      timeoutMs?: number;
      /** 書き込みの操作：送った後に答えが来なければ、届いたかが分からない（結果不明） */
      write?: boolean;
      /** どの資格情報で求めるか。既定は GET・HEAD が読む資格情報、POST・PUT・DELETE が書く資格情報 */
      credential?: "read" | "write";
      /** 時間切れを呼ぶ側で決める（本文を流す間は別の時間切れにする書き出しなど）。あれば timeoutMs は使わない */
      signal?: AbortSignal;
    } = {},
  ) {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { ...init.headers };
    const auth =
      (init.credential ?? (method === "GET" || method === "HEAD" ? "read" : "write")) === "write" ? writeAuthorization : authorization;
    if (auth) headers.authorization = auth;
    try {
      return await fetch(`${base.replace(/\/+$/, "")}/${path}`, {
        method,
        headers,
        body: init.body,
        dispatcher,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      // 原因の文言に URL や資格情報が入りうるので、ブラウザへは渡さない
      if (init.write) throw new BackendUnknownError();
      throw new BackendError("画像サーバーに接続できません");
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
      throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
    }
    return res.json();
  }

  /** 検査の全画像の Orthanc の画像の ID と、患者の値と UID の組（design.md §4） */
  async function instanceTags(id: string): Promise<[string, PatientInstance][]> {
    if (!isOrthancId(id)) {
      throw new BackendError("検査の ID が正しくありません", 400);
    }
    const json = await restJsonOrNull(`studies/${id}/instances-tags?simplify`);
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      throw new BackendError("画像のタグを読み込めません");
    }
    return Object.entries(json).map(([instanceId, raw]): [string, PatientInstance] => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new BackendError("画像のタグが正しくありません");
      }
      const tags = raw as Record<string, unknown>;
      const get = (key: string) => {
        const v = tags[key];
        if (v === undefined) {
          return "";
        }
        if (typeof v !== "string") {
          throw new BackendError("画像のタグが正しくありません");
        }
        return v;
      };
      return [instanceId, {
        PatientID: get("PatientID"),
        PatientName: get("PatientName"),
        PatientBirthDate: get("PatientBirthDate"),
        PatientSex: get("PatientSex"),
        AccessionNumber: get("AccessionNumber"),
        StudyInstanceUID: get("StudyInstanceUID"),
        SeriesInstanceUID: get("SeriesInstanceUID"),
        SOPInstanceUID: get("SOPInstanceUID"),
        SpecificCharacterSet: get("SpecificCharacterSet")
      }];
    });
  }

  /** Orthanc の変更の記録（/changes）のいまの位置 */
  async function lastChange(): Promise<number> {
    const json = await restJsonOrNull("changes?last");
    const last = json && typeof json === "object" ? (json as { Last?: unknown }).Last : undefined;
    if (typeof last !== "number" || !Number.isSafeInteger(last) || last < 0) {
      throw new BackendError("画像サーバーの変更の記録を読み込めません");
    }
    return last;
  }

  /** since より後の変更の記録に、ids の画像が届いた記録（NewInstance）があるか。読み切れなければ、あるとする */
  async function arrivedSince(since: number, ids: ReadonlySet<string>): Promise<boolean> {
    let position = since;
    for (let page = 0; page < 1000; page++) {
      const json = await restJsonOrNull(`changes?since=${position}&limit=1000`);
      const body = (json && typeof json === "object" ? json : {}) as { Changes?: unknown; Done?: unknown; Last?: unknown };
      if (!Array.isArray(body.Changes) || typeof body.Last !== "number" || typeof body.Done !== "boolean") {
        throw new BackendError("画像サーバーの変更の記録を読み込めません");
      }
      for (const change of body.Changes as { ChangeType?: unknown; ID?: unknown }[]) {
        if (change?.ChangeType === "NewInstance" && typeof change.ID === "string" && ids.has(change.ID)) {
          return true;
        }
      }
      if (body.Done || body.Last <= position) {
        return false;
      }
      position = body.Last;
    }
    return true;
  }

  /** 検査の全画像の、Orthanc の画像の ID・UID の組・ファイルの印（`/studies/{id}/instances` の FileUuid） */
  async function instanceFiles(id: string): Promise<{ instanceId: string; key: string; file: string }[]> {
    const tags = await instanceTags(id);
    const json = await restJsonOrNull(`studies/${id}/instances`);
    if (!Array.isArray(json)) {
      throw new BackendError("画像の一覧を読み込めません");
    }
    const files = new Map<string, string>();
    for (const raw of json) {
      const { ID, FileUuid } = (raw ?? {}) as { ID?: unknown; FileUuid?: unknown };
      if (typeof ID !== "string" || typeof FileUuid !== "string" || !FileUuid) {
        throw new BackendError("画像のファイルの印を読み込めません");
      }
      files.set(ID, FileUuid);
    }
    return tags.map(([instanceId, instance]) => {
      const file = files.get(instanceId);
      if (!file || !isOrthancId(instanceId)) {
        throw new BackendError("画像のファイルの印を読み込めません");
      }
      return { instanceId, key: instanceKey(instance), file };
    });
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
    if (!res.ok) throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
    return (await res.json()) as T;
  }

  /**
   * QIDO-RS の検査の検索を 1 回。ask 件まで求め、答えの行（BFF の側で条件を確かめ直したもの）と、続きがあるか
   * （返した数が ask に届いたか、Warning 299 があった。PS3.18 8.3.4.4.1）を返す
   */
  async function qidoStudies(ask: number, studyQuery?: StudyQuery): Promise<WindowAnswer> {
    const query = new URLSearchParams({ limit: String(ask) });
    const range = studyDateRange(studyQuery);
    if (range) query.set("StudyDate", range);
    // 詳細条件（生年月日・性別・受付番号・検査名）も Orthanc で絞る（上限 1000 件の外の古い検査も引ける）
    for (const [name, value] of studyQueryParams(studyQuery)) query.set(name, value);
    // 既定で返らないことがある項目を求める
    query.append("includefield", "00081030");
    query.append("includefield", "00080061");
    query.append("includefield", "00201206");
    query.append("includefield", "00201208");
    const res = await call(dicomwebUrl!, `studies?${query}`, { headers: { accept: "application/dicom+json, application/json" } });
    if (!res.ok) {
      await res.body?.cancel();
      throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
    }
    // 0 件は 200 と空の配列（古い版の規格では 204）
    const rows = res.status === 204 ? [] : ((await res.json()) as unknown);
    const datasets = Array.isArray(rows) ? (rows as DicomJsonDataset[]) : [];
    return {
      // 範囲と詳細条件は画像サーバーで絞るが、答えをそのまま信じず、ここでも確かめる
      rows: datasets.map(studyFromDicomJson).filter((s) => matchesStudyQuery(s, studyQuery)),
      more: datasets.length >= ask || warnsMoreResults(res.headers.get("warning")),
    };
  }

  /** UID は字を確かめてから URL に入れる（画像サーバーの path の外へ出さない） */
  function checkedUid(uid: string): string {
    if (!isDicomUid(uid)) throw new BackendError("StudyInstanceUID が正しくありません", 400);
    return uid;
  }

  return {
    kind: "orthanc",
    mock: false,

    async searchStudies(limit = STUDY_LIMIT, query?: StudyQuery) {
      // 上限より 1 件多く求め、上限ちょうどの答えを「続きがある」と取り違えない
      const max = clampStudyLimit(limit);
      return collectNewestStudies((q) => qidoStudies(max + 1, q), max, query, todayForWindows());
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

    async searchInstances(studyInstanceUid: string, seriesInstanceUid: string) {
      const query = new URLSearchParams();
      query.append("includefield", TAG.InstanceNumber);
      query.append("includefield", TAG.NumberOfFrames);
      // スライス位置は、画像サーバーが返したときだけ一覧に添える（返さなくてもよい）
      query.append("includefield", TAG.SliceLocation);
      // 監査の記録の「どの患者」に使う
      query.append("includefield", TAG.PatientID);
      const rows = await getJson<DicomJsonDataset[]>(
        dicomwebUrl!,
        `studies/${checkedUid(studyInstanceUid)}/series/${checkedUid(seriesInstanceUid)}/instances?${query}`,
      );
      // UID の形でない行は落とす（画面で選び、次の要求の path に入るため）。答えをそのまま信じず、
      // 検査・シリーズの UID が求めたものと同じ行だけを返す（Orthanc 26.9.1 の画像の単位の QIDO-RS は、
      // 検査・シリーズの UID と患者 ID を返すことを、2026-10-21 に結合の試験の 12 で測った）
      const sameStudy = (i: InstanceSummary) => i.studyInstanceUid === studyInstanceUid && i.seriesInstanceUid === seriesInstanceUid;
      return sortInstances(
        Array.isArray(rows) ? rows.map(instanceFromDicomJson).filter((i) => isDicomUid(i.sopInstanceUid) && sameStudy(i)) : [],
      );
    },

    async instanceDataset(studyInstanceUid: string, seriesInstanceUid: string, sopInstanceUid: string) {
      const path = `studies/${checkedUid(studyInstanceUid)}/series/${checkedUid(seriesInstanceUid)}/instances/${checkedUid(sopInstanceUid)}/metadata`;
      const res = await call(dicomwebUrl!, path, { headers: { accept: "application/dicom+json" } });
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
      }
      const rows = (await res.json()) as unknown;
      const ds = Array.isArray(rows) ? (rows[0] as DicomJsonDataset | undefined) : undefined;
      // 答えをそのまま信じない：求めた検査・シリーズ・画像のものだけを返す
      if (
        !ds ||
        stringValue(ds, TAG.StudyInstanceUID) !== studyInstanceUid ||
        stringValue(ds, TAG.SeriesInstanceUID) !== seriesInstanceUid ||
        stringValue(ds, TAG.SOPInstanceUID) !== sopInstanceUid
      ) {
        return null;
      }
      return ds;
    },

    async countStudies() {
      const stats = await getJson<{ CountStudies: number }>(orthancUrl, "statistics");
      return { count: stats.CountStudies, exact: true };
    },

    async studyListVersion() {
      // 変更の記録の最後の1件と番号だけを読む（検査の検索はしない）
      const json = await restJsonOrNull("changes?last");
      const last = json && typeof json === "object" ? (json as { Last?: unknown }).Last : undefined;
      if (typeof last !== "number" || !Number.isSafeInteger(last)) throw new BackendError("画像サーバーの変更の記録を読み込めませんでした");
      return String(last);
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
      // thumbnail・rendered は BFF が Accept を決める（ブラウザの <img> の Accept は Orthanc が 400 で断る）。ビューアの取得はそのまま渡す
      const accept = relayAccept(target.path, req.accept);
      if (accept) headers.accept = accept;
      // query の accept（PS3.18 8.3.3.1）は渡さない。受け取る型は、上で決めた Accept のヘッダーだけで求める
      const res = await call(dicomwebUrl!, `${target.path}${withoutAcceptParam(req.search)}`, { method: req.method, headers });
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
      // 変更の記録の最後の番号から CHANGES_WINDOW 件前を since にして、Orthanc Book の追い方（Last・Done）どおりに読み切る。
      // 読む範囲の前にも記録があり、受け取りの検査が limit 件に届かなければ「ここまでしか読めていない」（complete=false）
      const head = parseChanges(await restJsonOrNull("changes?last"));
      const from = Math.max(0, head.last - CHANGES_WINDOW);
      const read = await readChanges(
        async (since, pageLimit) =>
          parseChanges(await restJsonOrNull(`changes?${new URLSearchParams({ since: String(since), limit: String(pageLimit) })}`)),
        from,
        { limit: CHANGES_PAGE, maxCalls: CHANGES_MAX_CALLS },
      );
      const ids = receivedStudyIds(read.changes, limit);
      const out: ReceivedStudy[] = [];
      for (let i = 0; i < ids.length; i += RECEIVED_PARALLEL) {
        const batch = await Promise.all(ids.slice(i, i + RECEIVED_PARALLEL).map((x) => receivedOne(x.id, x.date)));
        for (const r of batch) if (r) out.push(r);
      }
      return { studies: out, complete: read.complete && (from === 0 || ids.length >= limit) };
    },

    async listModalities() {
      return modalitiesFromRest(await restJsonOrNull("modalities?expand"));
    },

    async echoModality(modalityId: string) {
      if (!isModalityName(modalityId)) throw new BackendError("接続先の名称が正しくありません", 400);
      // Orthanc 1.7.0 からは、本文に JSON が要る
      const res = await restPost(`modalities/${encodeURIComponent(modalityId)}/echo`, JSON.stringify({ Timeout: 10 }));
      await res.body?.cancel();
      if (res.status === 404) throw new BackendError("接続先が登録されていません", 404);
      if (res.ok) return true;
      // Orthanc は C-ECHO が通らないとき 500 を返す。ほか（資格情報の誤り・入口の誤りなど）は「つながらない」としない
      if (res.status === 500) return false;
      throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
    },

    async findStudiesByPatientId(patientId: string) {
      const res = await restPost("tools/find", JSON.stringify({
        Level: "Study",
        Query: { PatientID: checkedPatientId(patientId) },
        Expand: false
      }), { credential: "read" });
      if (!res.ok) {
        await res.body?.cancel();
        throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
      }
      const body: unknown = await res.json();
      if (!Array.isArray(body) || !body.every(isOrthancId)) {
        throw new BackendError("検査の ID を読み込めませんでした");
      }
      return body;
    },

    async studyPatient(orthancStudyId: string) {
      if (!isOrthancId(orthancStudyId)) {
        throw new BackendError("検査の ID が正しくありません", 400);
      }
      return studyPatientFromRest(await restJsonOrNull(`studies/${orthancStudyId}`));
    },

    // 届き終えていない検査を書き換えると、書き換えの最中に届いた画像が元の検査ごと消えうる（design.md §15）。
    async studyIsStable(id: string) {
      if (!isOrthancId(id)) {
        throw new BackendError("検査の ID が正しくありません", 400);
      }
      const json = await restJsonOrNull(`studies/${id}`);
      return Boolean(json && typeof json === "object" && (json as { IsStable?: unknown }).IsStable === true);
    },

    // 検査の要約だけでは部分反映を見落とすので、全画像を読む（design.md §4）。
    async studyInstanceTags(id: string) {
      return (await instanceTags(id)).map(([, instance]) => instance);
    },

    // 変更の記録の位置を先に読む（印を読んだ後に届いた画像は、位置より後の記録に必ず残る）
    async studyInstanceFiles(id: string) {
      const since = await lastChange();
      const files = await instanceFiles(id);
      return {
        since,
        files: Object.fromEntries(files.map(f => [f.key, f.file])),
        ids: Object.fromEntries(files.map(f => [f.key, f.instanceId]))
      };
    },

    // 印の値は期限の UNIX 秒（Orthanc の Lua が os.time() と比べる）。印の名前は Orthanc の UserMetadata に要る
    // （無ければ 404。検査が無いときも 404）
    async lockStudy(id: string, untilEpochSeconds: number) {
      if (!isOrthancId(id)) {
        throw new BackendError("検査の ID が正しくありません", 400);
      }
      if (!Number.isSafeInteger(untilEpochSeconds) || untilEpochSeconds <= 0) {
        throw new BackendError("付け替えの印の期限が正しくありません", 400);
      }
      const res = await call(orthancUrl, `studies/${id}/metadata/${LOCK_METADATA}`, {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: String(untilEpochSeconds),
        timeoutMs: POST_TIMEOUT_MS
      });
      await res.body?.cancel();
      if (!res.ok) {
        const hint = res.status === 404 ? `。Orthanc の UserMetadata に ${LOCK_METADATA} が要る` : "";
        throw new BackendError(`画像サーバーが付け替えの印を断りました（${res.status}）${hint}`);
      }
    },

    async unlockStudy(id: string) {
      if (!isOrthancId(id)) {
        throw new BackendError("検査の ID が正しくありません", 400);
      }
      const res = await call(orthancUrl, `studies/${id}/metadata/${LOCK_METADATA}`, { method: "DELETE", timeoutMs: POST_TIMEOUT_MS });
      await res.body?.cancel();
      if (!res.ok && res.status !== 404) {
        throw new BackendError(`画像サーバーが付け替えの印を外せませんでした（${res.status}）`);
      }
    },

    async studyInstanceOrigins(id: string) {
      const origins: Record<string, string | null> = {};
      for (const [instanceId, instance] of await instanceTags(id)) {
        if (!isOrthancId(instanceId)) {
          throw new BackendError("画像の ID が正しくありません");
        }
        const res = await call(orthancUrl, `instances/${instanceId}/metadata/ModifiedFrom`);
        if (res.status === 404) {
          await res.body?.cancel();
          origins[instanceKey(instance)] = null;
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel();
          throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
        }
        const value = (await res.text()).trim();
        origins[instanceKey(instance)] = isOrthancId(value) ? value : null;
      }
      return origins;
    },

    // 書き換えた元の画像だけを、画像の ID で 1 枚ずつ消す。検査ごとは消さない（最中に届いた画像を残す）。
    // 書き換えの前とファイルの印が違う画像と、消す直前に変更の記録で届き直しの見える画像（同じ UID で届き直して
    // 置き換わった画像）も消さない。Orthanc は画像を消すとその変更の記録も消すので、届き直しは消す前に確かめる。
    // 記録を読んでから消すまでの間に届き直した画像は消えうる（Orthanc の削除に条件を付けられない）。C-STORE はこの間、
    // 付け替えの印で Orthanc の Lua が断るので、残るのは REST・STOW-RS で届き直した画像だけ（design.md §15.4）
    async deleteStudyInstances(id: string, instances: PatientInstance[], source: SourceFiles, beforeEach?: () => Promise<void>) {
      const named = new Set(instances.map(instanceKey));
      for (const { instanceId, key, file } of await instanceFiles(id)) {
        if (!named.has(key) || source.files[key] !== file) {
          continue;
        }
        if (await arrivedSince(source.since, new Set([instanceId]))) {
          continue;
        }
        // 変更の記録を読み終えた後、消す直前に呼ぶ（読むのに時間がかかっても、その間に印が切れていれば消さない）
        await beforeEach?.();
        const res = await call(orthancUrl, `instances/${instanceId}`, { method: "DELETE", write: true, timeoutMs: POST_TIMEOUT_MS });
        await res.body?.cancel();
        if (res.status === 404) {
          continue;
        }
        if (!res.ok && isUncertainStatus(res.status)) {
          throw new BackendUnknownError();
        }
        if (!res.ok) {
          throw new BackendError(`画像サーバーが画像の削除を断りました（${res.status}）`);
        }
      }
    },

    // 仕事の完了は呼び手が確かめる（design.md §4）。元は消さない（KeepSource は既定の true）。患者 ID が同じなら
    // OverwriteInstances で元の画像が置き換わる。患者 ID が変わると元の検査が残り、呼び手が deleteStudyInstances で消す
    async modifyStudyKeepingUids(orthancStudyId: string, replace: Record<string, string>) {
      if (!isOrthancId(orthancStudyId)) {
        throw new BackendError("検査の ID が正しくありません", 400);
      }
      const res = await restPost(`studies/${orthancStudyId}/modify`, JSON.stringify({
        Replace: replace,
        Keep: ["StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID"],
        Force: true,
        Asynchronous: true
      }), { write: true });
      if (!res.ok) {
        if (isUncertainStatus(res.status)) {
          await res.body?.cancel();
          throw new BackendUnknownError();
        }
        // 応答には要求の値も入りうるので、既知の設定の理由だけを取り出す。
        const text = await res.text();
        const hint = /OverwriteInstances/i.test(text) ? "。Orthanc の OverwriteInstances が要る" : "";
        throw new BackendError(`画像サーバーが書き換えを断りました（${res.status}）${hint}`, res.status === 400 ? 400 : 502);
      }
      let body: unknown;
      try {
        body = await res.json();
      }
      catch {
        throw new BackendUnknownError();
      }
      const id = body && typeof body === "object" ? (body as {
        ID?: unknown;
      }).ID : undefined;
      if (!isJobId(id)) {
        throw new BackendUnknownError();
      }
      return { jobId: id };
    },

    async lookupStudyIds(studyInstanceUid: string) {
      const res = await restPost("tools/lookup", checkedUid(studyInstanceUid), { contentType: "text/plain", credential: "read" });
      if (!res.ok) {
        await res.body?.cancel();
        throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
      }
      return studyIdsFromLookup(await res.json());
    },

    async lookupStudy(studyInstanceUid: string) {
      return singleStudyId(await this.lookupStudyIds(studyInstanceUid));
    },

    async studyInfo(orthancStudyId: string) {
      if (!isOrthancId(orthancStudyId)) throw new BackendError("検査の ID が正しくありません", 400);
      return studyInfoFromRest(await restJsonOrNull(`studies/${orthancStudyId}`));
    },

    async sendStudy(modalityId: string, orthancStudyId: string) {
      if (!isModalityName(modalityId)) throw new BackendError("接続先の名称が正しくありません", 400);
      if (!isOrthancId(orthancStudyId)) throw new BackendError("検査の ID が正しくありません", 400);
      const res = await restPost(
        `modalities/${encodeURIComponent(modalityId)}/store`,
        JSON.stringify({ Resources: [orthancStudyId], Synchronous: false }),
        { write: true },
      );
      if (res.status === 404) {
        await res.body?.cancel();
        throw new BackendError("接続先が登録されていません", 404);
      }
      if (!res.ok) {
        await res.body?.cancel();
        // 手前の入口の 502・503・504 と移す答え（3xx）は、Orthanc が受けなかったと確かめられない（受けた後に答えが失われたかもしれない）
        if (isUncertainStatus(res.status)) throw new BackendUnknownError();
        throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
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

    async exportStudy(orthancStudyId: string) {
      if (!isOrthancId(orthancStudyId)) throw new BackendError("検査の ID が正しくありません", 400);
      // ZIP は大きくなりうる。答えが始まるまでは EXPORT_TIMEOUT_MS を待ち、本文を流す間は、塊と塊の間が
      // EXPORT_IDLE_MS を超えたときだけ切る（全体の長さの時間切れで、大きな検査の ZIP を途中で切らない）
      const abort = new AbortController();
      let timer = setTimeout(() => abort.abort(), EXPORT_TIMEOUT_MS);
      let res: Awaited<ReturnType<typeof call>>;
      try {
        res = await call(orthancUrl, `studies/${orthancStudyId}/archive`, { headers: { accept: "application/zip" }, signal: abort.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) {
        await res.body?.cancel();
        throw new BackendError("検査が見つかりません", 404);
      }
      if (!res.ok || res.status >= 300 || !res.body) {
        await res.body?.cancel();
        throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
      }
      const idle = () => {
        clearTimeout(timer);
        timer = setTimeout(() => abort.abort(), EXPORT_IDLE_MS);
      };
      idle();
      const body = (res.body as ReadableStream<Uint8Array>).pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            idle();
            controller.enqueue(chunk);
          },
          flush() {
            clearTimeout(timer);
          },
        }),
      );
      return new Response(body, { status: 200, headers: { "content-type": "application/zip" } });
    },

    async deleteStudy(orthancStudyId: string) {
      if (!isOrthancId(orthancStudyId)) throw new BackendError("検査の ID が正しくありません", 400);
      const res = await call(orthancUrl, `studies/${orthancStudyId}`, { method: "DELETE", write: true, timeoutMs: POST_TIMEOUT_MS });
      await res.body?.cancel();
      if (res.status === 404) throw new BackendError("検査が見つかりません", 404);
      // 受けなかったと確かめられない答えは結果不明（照らせば、消えたかが分かる）
      if (!res.ok && isUncertainStatus(res.status)) throw new BackendUnknownError();
      if (!res.ok) throw new BackendError(`画像サーバーがエラーを返しました（${res.status}）`);
    },
  };
}
