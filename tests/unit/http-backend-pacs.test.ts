import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpBackend } from "@/lib/backend/http";
import { readChanges } from "@/lib/backend/orthanc-rest";
import { BackendError, BackendUnknownError } from "@/lib/backend/types";

// 段 4：実の Orthanc の REST への要求（受け取りの記録・機器・C-ECHO・引き当て・送る・仕事の状態）を、
// 手元の HTTP のサーバー（Orthanc の REST の形で答える）に対して確かめる。答えの形は tests/fixtures/orthanc の見本。
// 書き込みの操作（POST）は書く資格情報で、読み取りは読む資格情報で求めることも見る。

const fixtures = "tests/fixtures/orthanc";
const read = (...p: string[]) => JSON.parse(readFileSync(path.join(fixtures, ...p), "utf8"));
const studies = readdirSync(path.join(fixtures, "rest/studies")).map((n) => read("rest/studies", n));
const series = readdirSync(path.join(fixtures, "rest/series")).map((n) => read("rest/series", n));
// 変更の記録：見本の検査の出来事（番号 1〜17）の後に、ほかの出来事を noise 件並べる
const NOISE_ID = "aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee";
const withNoise = (noise: number) => [
  ...read("made/changes.json").Changes,
  ...Array.from({ length: noise }, (_, i) => ({ ChangeType: "NewInstance", Date: "20261018T000000", ID: NOISE_ID, Path: `/instances/${NOISE_ID}`, ResourceType: "Instance", Seq: 18 + i })),
];
let allChanges = withNoise(250);
/** 見本の受信の日（2026-10-17。Asia/Tokyo の 0 時から翌日の 0 時まで） */
const DAY_1017_JST = { fromMs: Date.parse("2026-10-16T15:00:00Z"), toMs: Date.parse("2026-10-17T15:00:00Z") };
const lastSeq = () => allChanges.at(-1)!.Seq as number;
/** Orthanc が 1 回に返す数を切り詰める形（見本のサーバーの上限。BFF が求める 100 より小さい） */
const SERVER_MAX = 50;
const metadata = read("made/instance-metadata.json");
const modalities = read("made/modalities.json");
const JOB = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";

let server: Server;
let baseUrl: string;
const seen: { method: string; url: string; authorization?: string; body: string }[] = [];
let storeMode: "ok" | "drop" | "missing-id" | number = "ok";
let deleteMode: "ok" | number = "ok";
const DUP_UID = "1.2.826.0.1.3680043.8.498.777";
let changesMode: "ok" | "empty" | "stuck" = "ok";
/** /changes?last の Last を数でない形で返す（壊れた答え） */
let lastBroken = false;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", () => resolve(text));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const text = await body(req);
    const url = req.url ?? "";
    seen.push({ method: req.method ?? "", url, authorization: req.headers.authorization, body: text });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const m = req.method === "GET" ? /^\/studies\/([0-9a-f-]+)(\/series)?$/.exec(url) : null;
    if (url === "/changes?last") {
      return json(200, { Changes: allChanges.slice(-1), Done: true, Last: lastBroken ? "17" : lastSeq() });
    }
    if (url.startsWith("/changes?")) {
      const q = new URL(url, "http://x").searchParams;
      const since = Number(q.get("since") ?? 0);
      const limit = Math.min(Number(q.get("limit") ?? 100), SERVER_MAX);
      const part = allChanges.filter((c) => c.Seq > since).slice(0, limit);
      // 壊れた答えの形：2 頁目から、Done でないのに空の頁、または Last が進まない頁を返す
      if (changesMode !== "ok" && since > 0) {
        return json(200, { Changes: changesMode === "empty" ? [] : part, Done: false, Last: since });
      }
      return json(200, { Changes: part, Done: part.at(-1)?.Seq === lastSeq(), Last: part.at(-1)?.Seq ?? since });
    }
    if (m) {
      const study = studies.find((s) => s.ID === m[1]);
      if (!study) return json(404, {});
      return json(200, m[2] ? study.Series.map((id: string) => series.find((s) => s.ID === id)) : study);
    }
    const inst = /^\/instances\/([0-9a-f-]+)\/metadata\?expand$/.exec(url);
    if (inst) return json(200, metadata[inst[1]!] ?? {});
    if (url === "/modalities?expand") return json(200, modalities);
    if (req.method === "POST" && url === "/modalities/dtg/echo") return json(200, {});
    if (req.method === "POST" && url === "/modalities/offline/echo") return json(500, { Message: "DICOM network error" });
    if (req.method === "POST" && url === "/modalities/locked/echo") return json(401, {});
    if (req.method === "POST" && url === "/tools/lookup") {
      // 同じ UID の検査が患者違いで2つある形（DUP_UID）
      if (text === DUP_UID) {
        return json(200, [
          { ID: "00000000-00000000-00000000-00000000-00000001", Type: "Study" },
          { ID: "00000000-00000000-00000000-00000000-00000002", Type: "Study" },
        ]);
      }
      const study = studies.find((s) => s.MainDicomTags.StudyInstanceUID === text);
      return json(200, study ? [{ ID: study.ID, Path: `/studies/${study.ID}`, Type: "Study" }] : []);
    }
    const archive = /^\/studies\/([0-9a-f-]+)\/archive$/.exec(url);
    if (archive) {
      if (!studies.some((s) => s.ID === archive[1])) return json(404, {});
      res.writeHead(200, { "content-type": "application/zip" });
      return res.end(Buffer.from("PK\u0003\u0004zip-body"));
    }
    if (req.method === "DELETE" && url.startsWith("/studies/")) {
      if (typeof deleteMode === "number") return json(deleteMode, {});
      return json(200, {});
    }
    if (req.method === "POST" && url === "/modalities/dtg/store") {
      if (storeMode === "drop") return req.socket.destroy();
      if (typeof storeMode === "number") return json(storeMode, {});
      return json(200, storeMode === "missing-id" ? {} : { ID: JOB, Path: `/jobs/${JOB}` });
    }
    if (url === "/jobs?expand") {
      // 値の修正（段 6）：終わっていない書き換えの仕事を数える。送るの仕事・終わった書き換えは数えない
      return json(200, [
        { ID: "a", Type: "ResourceModification", State: "Running" },
        { ID: "b", Type: "ResourceModification", State: "Pending" },
        { ID: "c", Type: "ResourceModification", State: "Success" },
        { ID: "d", Type: "ResourceModification", State: "Failure" },
        { ID: "e", Type: "DicomModalityStore", State: "Running" },
      ]);
    }
    if (url === `/jobs/${JOB}`) {
      return json(200, {
        ID: JOB,
        State: "Success",
        Progress: 100,
        ErrorCode: 0,
        ErrorDescription: "Success",
        CreationTime: "20261019T230000.123456",
        CompletionTime: "20261019T230005.654321",
        Content: { Description: "REST API", RemoteAet: "DTG_SCP", Resources: ["secret-should-not-pass"] },
        Type: "DicomModalityStore",
      });
    }
    return json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
function backend(write = true) {
  return createHttpBackend({
    kind: "orthanc",
    mock: false,
    dicomwebUrl: `${baseUrl}/dicom-web`,
    orthancUrl: baseUrl,
    username: "reader",
    password: "read-secret",
    ...(write ? { writeUsername: "writer", writePassword: "write-secret" } : {}),
  });
}

describe("実の Orthanc の REST（段 4）", () => {
  it("受け取りの記録：期間の分を変更の記録の新しい側から遡り（上限 50 件で切り詰めるサーバーでも抜けない）、新しい順に組み立てる", async () => {
    allChanges = withNoise(250);
    seen.length = 0;
    const { studies: received, overLimit, complete } = await backend().receivedStudies({ ...DAY_1017_JST, limit: 3 });
    // 期間の中の 8 件が上限の 3 件を超えた：新しい 3 件だけ
    expect({ overLimit, complete }).toEqual({ overLimit: true, complete: true });
    expect(received.map((r) => r.summary.patientId)).toEqual(["JP-TEST-0004", "JP-TEST-0003", "JP-TEST-0002"]);
    // Orthanc の変更の記録の Date は時間帯の印なしの UTC。BFF は UTC と分かる形（Z つき）で返す（docs/spec.md の 3.3）
    expect(received[0]).toMatchObject({ receivedAt: "2026-10-17T13:32:00Z", remoteAet: "DTG_SCU", origin: "DicomProtocol", instanceCount: 6 });
    expect(received[0]!.summary).toMatchObject({ modalities: ["MR"], seriesCount: 2 });
    expect(seen[0]!.url).toBe("/changes?last");
    // 区間 (0, 267] を since=0 から読み、答えの Last を次の since にする（50 件ずつ返るので 6 回。求める数は区間の残り）
    expect(seen.filter((s) => s.url.startsWith("/changes?since")).map((s) => s.url)).toEqual(
      [0, 50, 100, 150, 200, 250].map((since) => `/changes?since=${since}&limit=${267 - since}`),
    );
    expect(seen.every((s) => s.method === "GET" && s.authorization === basic("reader", "read-secret"))).toBe(true);
    const all = await backend().receivedStudies({ ...DAY_1017_JST, limit: 1000 });
    expect(all.studies).toHaveLength(8);
    expect({ overLimit: all.overLimit, complete: all.complete }).toEqual({ overLimit: false, complete: true });
    // 状態：Orthanc の IsStable（見本の 1 件は、落ち着く前の形）
    expect(all.studies.filter((r) => r.stable === false)).toHaveLength(1);
    // 期間の外（翌日）には無い
    expect((await backend().receivedStudies({ fromMs: DAY_1017_JST.toMs, toMs: DAY_1017_JST.toMs + 86_400_000, limit: 1000 })).studies).toEqual([]);
  });

  it("受け取りの記録：期間の後の出来事が多くても、区切りごとに遡って期間の検査を見つける。読む回数の上限に届いたら「一部を読み込めない」", async () => {
    // 検査の出来事の後に、ほかの出来事が 6000 件ある：1000 件ずつ 7 つの区切りを遡る（1 区切りは 50 件ずつ 20 回）
    allChanges = withNoise(6000);
    const r = await backend().receivedStudies({ ...DAY_1017_JST, limit: 1000 });
    expect(r.studies).toHaveLength(8);
    expect(r.complete).toBe(true);
    // 12000 件：読む回数の上限（200 回）に届き、期間の検査まで遡れない
    allChanges = withNoise(12000);
    expect(await backend().receivedStudies({ ...DAY_1017_JST, limit: 1000 })).toEqual({ studies: [], overLimit: false, complete: false });
    allChanges = withNoise(250);
  });

  it("受け取りの記録：Done でないのに空の頁・Last が進まない頁が来たら、そこで止めて「ここまでしか読めていない」", async () => {
    for (const mode of ["empty", "stuck"] as const) {
      changesMode = mode;
      seen.length = 0;
      const r = await backend().receivedStudies({ ...DAY_1017_JST, limit: 1000 });
      expect(r.complete, mode).toBe(false);
      // 同じ since を読み続けない（1 頁目と、止まった 2 頁目の 2 回だけ）
      expect(seen.filter((s) => s.url.startsWith("/changes?since")), mode).toHaveLength(2);
    }
    changesMode = "ok";
  });

  it("一覧の版（自動更新）：変更の記録の最後の番号だけを、読む資格情報で読む。検査の検索はしない。壊れた答えは誤り", async () => {
    allChanges = withNoise(250);
    seen.length = 0;
    expect(await backend().studyListVersion()).toBe(String(lastSeq()));
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /changes?last"]);
    expect(seen[0]!.authorization).toBe(basic("reader", "read-secret"));
    lastBroken = true;
    await expect(backend().studyListVersion()).rejects.toBeInstanceOf(BackendError);
    lastBroken = false;
  });

  it("readChanges：読み切ったとするのは Done のときだけ（いまの記録が空で Done なら、読み切った）", async () => {
    const c = (seq: number) => ({ seq, changeType: "NewStudy", resourceType: "Study", id: NOISE_ID, date: "" });
    const opts = { limit: 100, maxCalls: 5 };
    expect(await readChanges(async () => ({ changes: [], last: 0, done: true }), 0, opts)).toEqual({ changes: [], complete: true });
    expect((await readChanges(async () => ({ changes: [], last: 0, done: false }), 0, opts)).complete).toBe(false);
    expect((await readChanges(async () => ({ changes: [c(1)], last: 0, done: false }), 0, opts)).complete).toBe(false);
    // 回数の上限に届けば未完了
    expect((await readChanges(async (since) => ({ changes: [c(since + 1)], last: since + 1, done: false }), 0, opts)).complete).toBe(false);
  });

  it("機器の一覧と C-ECHO（本文に Timeout の JSON。POST は書く資格情報）", async () => {
    seen.length = 0;
    const b = backend();
    expect((await b.listModalities()).map((m) => [m.id, m.aet, m.host, m.port])).toEqual([
      ["dtg", "DTG_SCP", "192.0.2.20", 11112],
      ["offline", "OFFLINE_EXAMPLE", "192.0.2.22", 104],
      ["workstation", "WS_EXAMPLE", "192.0.2.21", 104],
    ]);
    expect(await b.echoModality("dtg")).toBe(true);
    expect(await b.echoModality("offline")).toBe(false);
    await expect(b.echoModality("nothing")).rejects.toMatchObject({ status: 404 });
    // 資格情報の誤りなどは「つながらない」とせず、誤りにする
    await expect(b.echoModality("locked")).rejects.toThrow(BackendError);
    await expect(b.echoModality("../x")).rejects.toMatchObject({ status: 400 });
    const echo = seen.find((s) => s.url === "/modalities/dtg/echo")!;
    expect(JSON.parse(echo.body)).toEqual({ Timeout: 10 });
    expect(echo.authorization).toBe(basic("writer", "write-secret"));
  });

  it("書く資格情報が無ければ、読む資格情報で書く（試しの環境）", async () => {
    seen.length = 0;
    await backend(false).echoModality("dtg");
    expect(seen[0]!.authorization).toBe(basic("reader", "read-secret"));
  });

  it("引き当てと送る：検査の ID を引き、非同期で送り、仕事の ID を受ける。仕事の状態は中身を返さない", async () => {
    seen.length = 0;
    const b = backend();
    const id = await b.lookupStudy("1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012");
    expect(id).toBe("3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919");
    expect(await b.lookupStudy("1.2.3")).toBeNull();
    storeMode = "ok";
    expect(await b.sendStudy("dtg", id!)).toEqual({ jobId: JOB });
    const store = seen.find((s) => s.url === "/modalities/dtg/store")!;
    expect(JSON.parse(store.body)).toEqual({ Resources: [id], Synchronous: false });
    expect(store.authorization).toBe(basic("writer", "write-secret"));
    // 引き当ては Orthanc の中身を変えない読み取りなので、読む資格情報で求める
    expect(seen.find((s) => s.url === "/tools/lookup")!.authorization).toBe(basic("reader", "read-secret"));
    const job = await b.jobStatus(JOB);
    expect(job).toEqual({
      id: JOB,
      state: "Success",
      progress: 100,
      errorCode: 0,
      errorDescription: "Success",
      // 仕事の時刻も Orthanc は UTC で返す。Z つきで返す
      creationTime: "2026-10-19T23:00:00Z",
      completionTime: "2026-10-19T23:00:05Z",
    });
    expect(JSON.stringify(job)).not.toContain("secret-should-not-pass");
    expect(await b.jobStatus("not-a-job")).toBeNull();
    // 終わっていない書き換えの仕事の数（仕事の ID が分からない値の修正を、管理者が解く前に見る）
    expect(await b.unfinishedModifyJobs()).toBe(2);
  });

  it("送ったあとに答えが来ない・答えに仕事の ID が無いときは、結果不明（BackendUnknownError）", async () => {
    const b = backend();
    storeMode = "drop";
    await expect(b.sendStudy("dtg", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919")).rejects.toThrow(BackendUnknownError);
    storeMode = "missing-id";
    await expect(b.sendStudy("dtg", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919")).rejects.toThrow(BackendUnknownError);
    // 手前の入口の 502・503・504 と、移す答え（3xx）も、受けなかったと確かめられないので結果不明
    for (const status of [502, 503, 504, 302]) {
      storeMode = status;
      await expect(b.sendStudy("dtg", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919"), String(status)).rejects.toThrow(BackendUnknownError);
    }
    // Orthanc が断ったと分かる答え（400・500 など）は失敗
    for (const status of [400, 500]) {
      storeMode = status;
      const error = await b.sendStudy("dtg", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919").catch((e: unknown) => e);
      expect(error, String(status)).toBeInstanceOf(BackendError);
      expect(error).not.toBeInstanceOf(BackendUnknownError);
    }
    storeMode = "ok";
    // 形の誤りは Orthanc へ送らずに断る（結果不明ではない）
    await expect(b.sendStudy("dtg", "../x")).rejects.toThrow(BackendError);
    await expect(b.sendStudy("a/b", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919")).rejects.toThrow(BackendError);
  });
});

describe("実の Orthanc の REST（段 5：引き当ての重なり・版・書き出し・削除）", () => {
  const ID = "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919";

  it("同じ UID の検査が2つあれば、引き当ては全部を返し、1つを選ぶ引き当ては 409 で断る", async () => {
    const b = backend();
    expect(await b.lookupStudyIds(DUP_UID)).toHaveLength(2);
    await expect(b.lookupStudy(DUP_UID)).rejects.toMatchObject({ status: 409 });
  });

  it("検査の要点と版（LastUpdate）を読む", async () => {
    expect(await backend().studyInfo(ID)).toMatchObject({
      orthancId: ID,
      studyInstanceUid: "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012",
      patientId: "JP-TEST-0004",
      version: "20261017T231203",
      seriesCount: 1,
    });
    expect(await backend().studyInfo("00000000-00000000-00000000-00000000-0000000f")).toBeNull();
  });

  it("書き出しは読む資格情報で ZIP を流し、無い検査は 404", async () => {
    seen.length = 0;
    const res = await backend().exportStudy(ID);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 2).toString()).toBe("PK");
    expect(seen.at(-1)!.authorization).toBe(basic("reader", "read-secret"));
    await expect(backend().exportStudy("00000000-00000000-00000000-00000000-0000000f")).rejects.toMatchObject({ status: 404 });
  });

  it("削除は書く資格情報で DELETE を求める。502・503・504 は結果不明、500 は失敗", async () => {
    seen.length = 0;
    deleteMode = "ok";
    await backend().deleteStudy(ID);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: `/studies/${ID}`, authorization: basic("writer", "write-secret") });
    for (const status of [502, 503, 504]) {
      deleteMode = status;
      await expect(backend().deleteStudy(ID)).rejects.toThrow(BackendUnknownError);
    }
    deleteMode = 500;
    const error = await backend().deleteStudy(ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).not.toBeInstanceOf(BackendUnknownError);
    deleteMode = "ok";
    await expect(backend().deleteStudy("../x")).rejects.toMatchObject({ status: 400 });
  });
});
