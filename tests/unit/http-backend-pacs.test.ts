import { readdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpBackend } from "@/lib/backend/http";
import { BackendError, BackendUnknownError } from "@/lib/backend/types";

// 段 4：実の Orthanc の REST への要求（受け取りの記録・機器・C-ECHO・引き当て・送る・仕事の状態）を、
// 手元の HTTP のサーバー（Orthanc の REST の形で答える）に対して確かめる。答えの形は tests/fixtures/orthanc の見本。
// 書き込みの操作（POST）は書く資格情報で、読み取りは読む資格情報で求めることも見る。

const fixtures = "tests/fixtures/orthanc";
const read = (...p: string[]) => JSON.parse(readFileSync(path.join(fixtures, ...p), "utf8"));
const studies = readdirSync(path.join(fixtures, "rest/studies")).map((n) => read("rest/studies", n));
const series = readdirSync(path.join(fixtures, "rest/series")).map((n) => read("rest/series", n));
// 変更の記録：見本の検査の出来事（番号 1〜17）の後に、ほかの出来事を 250 件並べる（新しい側から読むと、3 頁目で検査に届く）
const NOISE_ID = "aaaaaaaa-bbbbbbbb-cccccccc-dddddddd-eeeeeeee";
const allChanges = [
  ...read("made/changes.json").Changes,
  ...Array.from({ length: 250 }, (_, i) => ({ ChangeType: "NewInstance", Date: "20261018T000000", ID: NOISE_ID, Path: `/instances/${NOISE_ID}`, ResourceType: "Instance", Seq: 18 + i })),
];
const LAST = allChanges.at(-1)!.Seq as number;
/** Orthanc が 1 回に返す数を切り詰める形（見本のサーバーの上限） */
const SERVER_MAX = 100;
const metadata = read("made/instance-metadata.json");
const modalities = read("made/modalities.json");
const JOB = "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e";

let server: Server;
let baseUrl: string;
const seen: { method: string; url: string; authorization?: string; body: string }[] = [];
let storeMode: "ok" | "drop" | "missing-id" = "ok";

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
    const m = /^\/studies\/([0-9a-f-]+)(\/series)?$/.exec(url);
    if (url === "/changes?last") return json(200, { Changes: allChanges.slice(-1), Done: true, Last: LAST });
    if (url.startsWith("/changes?")) {
      const q = new URL(url, "http://x").searchParams;
      const since = Number(q.get("since") ?? 0);
      const limit = Math.min(Number(q.get("limit") ?? 100), SERVER_MAX);
      const part = allChanges.filter((c) => c.Seq > since).slice(0, limit);
      return json(200, { Changes: part, Done: part.at(-1)?.Seq === LAST, Last: part.at(-1)?.Seq ?? since });
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
      const study = studies.find((s) => s.MainDicomTags.StudyInstanceUID === text);
      return json(200, study ? [{ ID: study.ID, Path: `/studies/${study.ID}`, Type: "Study" }] : []);
    }
    if (req.method === "POST" && url === "/modalities/dtg/store") {
      if (storeMode === "drop") return req.socket.destroy();
      return json(200, storeMode === "missing-id" ? {} : { ID: JOB, Path: `/jobs/${JOB}` });
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
  it("受け取りの記録：変更の記録を新しい側から 1 頁ずつさかのぼり、検査・画像の数・送ってきた機器を組み立てる", async () => {
    seen.length = 0;
    const received = await backend().receivedStudies(3);
    expect(received.map((r) => r.summary.patientId)).toEqual(["JP-TEST-0004", "JP-TEST-0003", "JP-TEST-0002"]);
    expect(received[0]).toMatchObject({ receivedAt: "2026-10-17T13:32:00", remoteAet: "DTG_SCU", origin: "DicomProtocol", instanceCount: 6 });
    expect(received[0]!.summary).toMatchObject({ modalities: ["MR"], seriesCount: 2 });
    expect(seen[0]!.url).toBe("/changes?last");
    // 新しい側から 100 件ずつ（サーバーが切り詰めても抜けない）。3 頁目で検査に届いて止まる
    expect(seen.filter((s) => s.url.startsWith("/changes?since")).map((s) => s.url)).toEqual([
      "/changes?since=167&limit=100",
      "/changes?since=67&limit=100",
      "/changes?since=0&limit=100",
    ]);
    expect(seen.every((s) => s.method === "GET" && s.authorization === basic("reader", "read-secret"))).toBe(true);
    expect(await backend().receivedStudies(100)).toHaveLength(8);
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
      creationTime: "2026-10-19T23:00:00",
      completionTime: "2026-10-19T23:00:05",
    });
    expect(JSON.stringify(job)).not.toContain("secret-should-not-pass");
    expect(await b.jobStatus("not-a-job")).toBeNull();
  });

  it("送ったあとに答えが来ない・答えに仕事の ID が無いときは、結果不明（BackendUnknownError）", async () => {
    const b = backend();
    storeMode = "drop";
    await expect(b.sendStudy("dtg", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919")).rejects.toThrow(BackendUnknownError);
    storeMode = "missing-id";
    await expect(b.sendStudy("dtg", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919")).rejects.toThrow(BackendUnknownError);
    storeMode = "ok";
    // 形の誤りは Orthanc へ送らずに断る（結果不明ではない）
    await expect(b.sendStudy("dtg", "../x")).rejects.toThrow(BackendError);
    await expect(b.sendStudy("a/b", "3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919")).rejects.toThrow(BackendError);
  });
});
