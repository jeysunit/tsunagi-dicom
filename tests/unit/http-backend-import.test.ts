import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHttpBackend } from "@/lib/backend/http";
import { BackendError, BackendUnknownError, IMPORT_LABEL } from "@/lib/backend/types";
import { dicomFile } from "./helpers/dicom-file";

// 段 6：インポートの実の Orthanc の REST への要求（POST /instances・ラベル・/tools/find・/tools/lookup）を、
// 手元の HTTP のサーバー（Orthanc Book の REST API の形で答える）に対して確かめる。書き込みは書く資格情報で求めることも見る。

const STUDY_ID = "27f7126f-4f66a988-7e83e3f1-37d4d1c4-2c4b1f7a";
const INSTANCE_ID = "8f5a1c0e-1d2e3f40-51627384-95a6b7c8-d9e0f1a2";
let server: Server;
let baseUrl: string;
const seen: { method: string; url: string; authorization?: string; bytes: number; type?: string }[] = [];
let storeMode: "ok" | "already" | "filtered" | "odd" | "drop" | 400 | 503 = "ok";
let deleteMode: "ok" | 500 | 503 = "ok";

function bytesOf(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await bytesOf(req);
    const url = req.url ?? "";
    seen.push({ method: req.method ?? "", url, authorization: req.headers.authorization, bytes: body.length, type: req.headers["content-type"] });
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method === "POST" && url === "/instances") {
      if (storeMode === "drop") return req.socket.destroy();
      if (typeof storeMode === "number") return json(storeMode, { Message: "error" });
      if (storeMode === "odd") return json(200, { Status: "Success" });
      const status = storeMode === "already" ? "AlreadyStored" : storeMode === "filtered" ? "FilteredOut" : "Success";
      return json(200, { ID: INSTANCE_ID, ParentPatient: "p", ParentSeries: "s", ParentStudy: STUDY_ID, Path: `/instances/${INSTANCE_ID}`, Status: status });
    }
    if (req.method === "PUT" && url === `/studies/${STUDY_ID}/labels/${IMPORT_LABEL}`) {
      res.writeHead(200);
      return res.end();
    }
    if (req.method === "POST" && url === "/tools/find") {
      return json(200, [{ ID: STUDY_ID, MainDicomTags: { StudyInstanceUID: "1.2.3.4" }, Labels: [IMPORT_LABEL] }]);
    }
    if (req.method === "POST" && url === "/tools/lookup") {
      const one = { ID: INSTANCE_ID, Path: `/instances/${INSTANCE_ID}`, Type: "Instance" };
      if (body.toString() === "1.2.826.0.1.3680043.8.498.1") return json(200, [one]);
      // 患者違いで同じ SOP Instance UID の画像が2つある
      if (body.toString() === "1.2.826.0.1.3680043.8.498.3") return json(200, [one, { ...one, ID: STUDY_ID }]);
      return json(200, []);
    }
    if (req.method === "GET" && url === `/instances/${INSTANCE_ID}/study`) return json(200, { ID: STUDY_ID });
    if (req.method === "GET" && url === `/instances/${INSTANCE_ID}`) return json(200, { ID: INSTANCE_ID, ParentSeries: "s" });
    if (req.method === "GET" && url === `/studies/${STUDY_ID}/instances`) {
      return json(200, [{ ID: INSTANCE_ID, MainDicomTags: { SOPInstanceUID: "1.2.826.0.1.3680043.8.498.1" } }, { ID: "x", MainDicomTags: { SOPInstanceUID: "1.2.826.0.1.3680043.8.498.4" } }]);
    }
    if (req.method === "GET" && url === `/studies/${INSTANCE_ID}/instances`) return json(200, [{ ID: "x", MainDicomTags: {} }]);
    if (req.method === "DELETE" && url === `/instances/${INSTANCE_ID}`) {
      if (typeof deleteMode === "number") return json(deleteMode, { Message: "error" });
      return json(200, {});
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});
beforeEach(() => {
  seen.length = 0;
  storeMode = "ok";
  deleteMode = "ok";
});

const basic = (u: string, p: string) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const backend = () =>
  createHttpBackend({
    kind: "orthanc",
    mock: false,
    dicomwebUrl: `${baseUrl}/dicom-web`,
    orthancUrl: baseUrl,
    username: "reader",
    password: "read-secret",
    writeUsername: "writer",
    writePassword: "write-secret",
  });

describe("実の Orthanc の REST（段 6：インポート）", () => {
  it("ファイルを本文のまま POST /instances へ書く資格情報で送り、新しく入った・もうあったを読む", async () => {
    const file = dicomFile();
    expect(await backend().importInstance(file)).toEqual({ status: "Success", instanceId: INSTANCE_ID, orthancStudyId: STUDY_ID });
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/instances", authorization: basic("writer", "write-secret"), bytes: file.byteLength, type: "application/dicom" });
    storeMode = "already";
    expect(await backend().importInstance(file)).toEqual({ status: "AlreadyStored", instanceId: INSTANCE_ID, orthancStudyId: STUDY_ID });
  });

  it("Orthanc が受けなかった（FilteredOut・400）は失敗、答えが来ない・503・読めない 2xx の答えは結果不明", async () => {
    for (const mode of ["filtered", 400] as const) {
      storeMode = mode;
      const error = await backend().importInstance(dicomFile()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackendError);
      expect(error).not.toBeInstanceOf(BackendUnknownError);
    }
    for (const mode of ["drop", 503, "odd"] as const) {
      storeMode = mode;
      await expect(backend().importInstance(dicomFile())).rejects.toThrow(BackendUnknownError);
    }
  });

  it("印は検査のラベルを PUT で付け、印のある検査は /tools/find で読む", async () => {
    await backend().labelImported(STUDY_ID);
    expect(seen.at(-1)).toMatchObject({ method: "PUT", url: `/studies/${STUDY_ID}/labels/${IMPORT_LABEL}`, authorization: basic("writer", "write-secret") });
    expect([...(await backend().importedStudyUids())]).toEqual(["1.2.3.4"]);
    expect(seen.at(-1)).toMatchObject({ method: "POST", url: "/tools/find", authorization: basic("reader", "read-secret") });
    await expect(backend().labelImported("../x")).rejects.toMatchObject({ status: 400 });
  });

  it("結果不明を照らす：SOP Instance UID を引き当て、画像の親の検査を返す。無ければ null", async () => {
    expect(await backend().findInstanceStudy("1.2.826.0.1.3680043.8.498.1")).toEqual({ instanceId: INSTANCE_ID, orthancStudyId: STUDY_ID });
    expect(seen.at(-1)).toMatchObject({ authorization: basic("reader", "read-secret") });
    expect(await backend().findInstanceStudy("1.2.826.0.1.3680043.8.498.2")).toBeNull();
  });

  it("同じ SOP Instance UID の画像が2つ以上あれば、どれかを選ばずに 409", async () => {
    await expect(backend().findInstanceStudy("1.2.826.0.1.3680043.8.498.3")).rejects.toMatchObject({ status: 409 });
  });

  it("取り込んだ画像を消すときは DELETE /instances/{id} を書く資格情報で送り、無い・失敗・結果不明を分ける", async () => {
    await backend().deleteImportedInstance(INSTANCE_ID);
    expect(seen.at(-1)).toMatchObject({ method: "DELETE", url: `/instances/${INSTANCE_ID}`, authorization: basic("writer", "write-secret") });
    await expect(backend().deleteImportedInstance(STUDY_ID)).rejects.toMatchObject({ status: 404 });
    deleteMode = 500;
    const failed = await backend().deleteImportedInstance(INSTANCE_ID).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(BackendError);
    expect(failed).not.toBeInstanceOf(BackendUnknownError);
    deleteMode = 503;
    await expect(backend().deleteImportedInstance(INSTANCE_ID)).rejects.toThrow(BackendUnknownError);
    await expect(backend().deleteImportedInstance("../x")).rejects.toMatchObject({ status: 400 });
  });

  it("検査の画像の SOP Instance UID の全部を GET /studies/{id}/instances で読む。無い検査は空、読めない画像があれば投げる", async () => {
    expect(await backend().studyInstanceSopUids(STUDY_ID)).toEqual(["1.2.826.0.1.3680043.8.498.1", "1.2.826.0.1.3680043.8.498.4"]);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: `/studies/${STUDY_ID}/instances`, authorization: basic("reader", "read-secret") });
    expect(await backend().studyInstanceSopUids("00000000-00000000-00000000-00000000-00000000")).toEqual([]);
    await expect(backend().studyInstanceSopUids(INSTANCE_ID)).rejects.toThrow(BackendError);
  });

  it("画像があるかは GET /instances/{id} を読む資格情報で読み、404 なら無い", async () => {
    expect(await backend().instanceExists(INSTANCE_ID)).toBe(true);
    expect(seen.at(-1)).toMatchObject({ method: "GET", url: `/instances/${INSTANCE_ID}`, authorization: basic("reader", "read-secret") });
    expect(await backend().instanceExists(STUDY_ID)).toBe(false);
    await expect(backend().instanceExists("../x")).rejects.toMatchObject({ status: 400 });
  });
});
