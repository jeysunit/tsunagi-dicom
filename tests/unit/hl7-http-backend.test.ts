import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("undici", async (original) => ({
  ...await original<typeof import("undici")>(),
  fetch: state.fetch
}));
import { createHttpBackend } from "@/lib/backend/http";
import { BackendError, BackendUnknownError } from "@/lib/backend/types";
const id = "00000000-00000000-00000000-00000000-00000001";
const newId = "00000000-0000-4000-8000-000000000002";
const backend = () => createHttpBackend({
  kind: "orthanc",
  mock: false,
  orthancUrl: "http://pacs.example.org",
  dicomwebUrl: "http://pacs.example.org/dicom-web",
  username: "reader",
  password: "synthetic-read",
  writeUsername: "writer",
  writePassword: "synthetic-write"
});
beforeEach(() => {
  state.fetch.mockReset();
});

describe("HL7 の Orthanc REST の要求", () => {
  it("患者の検索は読む資格情報で tools/find に送る", async () => {
    state.fetch.mockResolvedValue(Response.json([id]));
    expect(await backend().findStudiesByPatientId("P1")).toEqual([id]);
    const [url, init] = state.fetch.mock.calls[0]!;
    expect(url).toBe("http://pacs.example.org/tools/find");
    expect(JSON.parse(init.body)).toEqual({ Level: "Study", Query: { PatientID: "P1" }, Expand: false });
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("reader:synthetic-read").toString("base64")}`);
  });
  it.each(["P*", "P?", "P\\X", "P\n", "P\u0080"])("当てはめを検索へ渡さない", async (patientId) => {
    await expect(backend().findStudiesByPatientId(patientId)).rejects.toMatchObject({ status: 400 });
    expect(state.fetch).not.toHaveBeenCalled();
  });
  it("患者の現在の 6 つの値を REST から読む", async () => {
    state.fetch.mockResolvedValue(Response.json({
      ID: id,
      PatientMainDicomTags: {
        PatientID: "P1",
        PatientName: "F^G",
        PatientBirthDate: "20000101",
        PatientSex: "O"
      },
      MainDicomTags: { StudyInstanceUID: "1.2.3", AccessionNumber: "A1" }
    }));
    expect(await backend().studyPatient(id)).toEqual({
      PatientID: "P1",
      PatientName: "F^G",
      PatientBirthDate: "20000101",
      PatientSex: "O",
      StudyInstanceUID: "1.2.3",
      AccessionNumber: "A1"
    });
    expect(state.fetch.mock.calls[0]![1].method).toBe("GET");
  });
  it.each([
    ["患者 ID の変わる", { PatientID: "P2" }],
    ["患者 ID の変わらない", { PatientName: "NEW^NAME" }]
  ])("%s書き換えも、UID を保ち元を残す要求（KeepSource を付けない）を、書く資格情報で送る", async (_name, replace) => {
    state.fetch.mockResolvedValue(Response.json({ ID: newId }));
    expect(await backend().modifyStudyKeepingUids(id, replace)).toEqual({ jobId: newId });
    const [url, init] = state.fetch.mock.calls[0]!;
    expect(url).toBe(`http://pacs.example.org/studies/${id}/modify`);
    expect(JSON.parse(init.body)).toEqual({
      Replace: replace,
      Keep: ["StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID"],
      Force: true,
      Asynchronous: true
    });
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("writer:synthetic-write").toString("base64")}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  describe("元の画像の削除", () => {
    const tag = (sop: string) => ({ PatientID: "T1", StudyInstanceUID: "1.2", SeriesInstanceUID: "1.2.3", SOPInstanceUID: sop });
    const full = (sop: string) => ({ ...tag(sop), PatientName: "", PatientBirthDate: "", PatientSex: "", AccessionNumber: "", SpecificCharacterSet: "" });
    const one = "00000000-00000000-00000000-00000000-0000000a";
    const two = "00000000-00000000-00000000-00000000-0000000b";
    const late = "00000000-00000000-00000000-00000000-0000000c";
    /** 検査の画像のタグと、画像の一覧（FileUuid）の 2 つの答え */
    const listing = (files: Record<string, string>) => {
      state.fetch
        .mockResolvedValueOnce(Response.json({ [one]: tag("1.2.3.1"), [two]: tag("1.2.3.2"), [late]: tag("1.2.3.3") }))
        .mockResolvedValueOnce(Response.json(Object.entries(files).map(([ID, FileUuid]) => ({ ID, FileUuid }))));
    };
    const files = { "1.2|1.2.3|1.2.3.1": "f1", "1.2|1.2.3|1.2.3.2": "f2" };
    const changes = (list: { ChangeType: string; ID: string }[], done = true, last = 20) =>
      state.fetch.mockResolvedValueOnce(Response.json({ Changes: list, Done: done, Last: last }));
    it("変更の記録の位置を先に読み、画像ごとのファイルの印と画像の ID を、UID の組を鍵にして読む", async () => {
      state.fetch.mockResolvedValueOnce(Response.json({ Changes: [], Done: true, Last: 7 }));
      listing({ [one]: "f1", [two]: "f2", [late]: "f3" });
      expect(await backend().studyInstanceFiles(id)).toEqual({
        since: 7,
        files: { "1.2|1.2.3|1.2.3.1": "f1", "1.2|1.2.3|1.2.3.2": "f2", "1.2|1.2.3|1.2.3.3": "f3" },
        ids: { "1.2|1.2.3|1.2.3.1": one, "1.2|1.2.3|1.2.3.2": two, "1.2|1.2.3|1.2.3.3": late }
      });
      expect(state.fetch.mock.calls[0]![0]).toBe("http://pacs.example.org/changes?last");
      expect(state.fetch.mock.calls[2]![0]).toBe(`http://pacs.example.org/studies/${id}/instances`);
    });
    it("ファイルの印が無ければ読めないとする", async () => {
      state.fetch.mockResolvedValueOnce(Response.json({ Changes: [], Done: true, Last: 7 }));
      listing({ [one]: "f1", [two]: "", [late]: "f3" });
      await expect(backend().studyInstanceFiles(id)).rejects.toThrow("ファイルの印");
    });
    it("名指しで、ファイルの印が書き換えの前と同じ画像だけを、画像の ID で 1 枚ずつ、書く資格情報で消す", async () => {
      // 2 枚目は同じ UID で届き直して印が変わった
      listing({ [one]: "f1", [two]: "f2-resent", [late]: "f3" });
      // 消す直前に、変更の記録でその画像の届き直しが無いかを読む（ほかの画像の記録は関係ない）
      changes([{ ChangeType: "NewInstance", ID: late }]);
      state.fetch.mockResolvedValueOnce(new Response("", { status: 200 }));
      await backend().deleteStudyInstances(id, [full("1.2.3.1"), full("1.2.3.2")], { since: 7, files });
      expect(state.fetch.mock.calls.map(c => c[0])).toEqual([
        `http://pacs.example.org/studies/${id}/instances-tags?simplify`,
        `http://pacs.example.org/studies/${id}/instances`,
        "http://pacs.example.org/changes?since=7&limit=1000",
        `http://pacs.example.org/instances/${one}`
      ]);
      const init = state.fetch.mock.calls[3]![1];
      expect(init.method).toBe("DELETE");
      expect(init.headers.authorization).toBe(`Basic ${Buffer.from("writer:synthetic-write").toString("base64")}`);
    });
    it("消す直前に、変更の記録の続きの頁まで読み、位置より後に届き直した画像は消さない", async () => {
      listing({ [one]: "f1", [two]: "f2", [late]: "f3" });
      changes([{ ChangeType: "StableStudy", ID: id }], false, 15);
      changes([{ ChangeType: "NewInstance", ID: one }], true, 16);
      await backend().deleteStudyInstances(id, [full("1.2.3.1")], { since: 7, files });
      expect(state.fetch.mock.calls.map(c => c[0]).slice(2)).toEqual([
        "http://pacs.example.org/changes?since=7&limit=1000",
        "http://pacs.example.org/changes?since=15&limit=1000"
      ]);
      expect(state.fetch.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(false);
    });
    it("変更の記録の形が違えば、消さずに読めないとする", async () => {
      listing({ [one]: "f1", [two]: "f2", [late]: "f3" });
      state.fetch.mockResolvedValueOnce(Response.json({ Changes: "x" }));
      await expect(backend().deleteStudyInstances(id, [full("1.2.3.1")], { since: 7, files })).rejects.toThrow("変更の記録");
      expect(state.fetch.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(false);
    });
    it.each([[502, BackendUnknownError], [403, BackendError]])("画像の削除の状態 %i を投げる", async (status, error) => {
      listing({ [one]: "f1", [two]: "f2", [late]: "f3" });
      changes([]);
      state.fetch.mockResolvedValueOnce(new Response("", { status }));
      await expect(backend().deleteStudyInstances(id, [full("1.2.3.1")], { since: 7, files })).rejects.toBeInstanceOf(error);
    });
    it("変更の記録を読んだ後、1 枚を消す直前に beforeEach を呼び、投げれば残りを消さない", async () => {
      listing({ [one]: "f1", [two]: "f2", [late]: "f3" });
      changes([]);
      const beforeEach = vi.fn().mockRejectedValue(new Error("synthetic renew failure"));
      await expect(backend().deleteStudyInstances(id, [full("1.2.3.1")], { since: 7, files }, beforeEach)).rejects.toThrow("synthetic");
      expect(beforeEach).toHaveBeenCalledTimes(1);
      expect(state.fetch.mock.calls.some(c => c[1]?.method === "DELETE")).toBe(false);
    });
    it("写しの元（ModifiedFrom）を画像ごとに読み、無い画像は null にする", async () => {
      state.fetch
        .mockResolvedValueOnce(Response.json({ [one]: tag("1.2.3.1"), [two]: tag("1.2.3.2") }))
        .mockResolvedValueOnce(new Response(late, { status: 200 }))
        .mockResolvedValueOnce(new Response("", { status: 404 }));
      expect(await backend().studyInstanceOrigins(id)).toEqual({ "1.2|1.2.3|1.2.3.1": late, "1.2|1.2.3|1.2.3.2": null });
      expect(state.fetch.mock.calls.map(c => c[0]).slice(1)).toEqual([
        `http://pacs.example.org/instances/${one}/metadata/ModifiedFrom`,
        `http://pacs.example.org/instances/${two}/metadata/ModifiedFrom`
      ]);
    });
    it("写しの元を読めなければ投げる", async () => {
      state.fetch
        .mockResolvedValueOnce(Response.json({ [one]: tag("1.2.3.1") }))
        .mockResolvedValueOnce(new Response("", { status: 500 }));
      await expect(backend().studyInstanceOrigins(id)).rejects.toBeInstanceOf(BackendError);
    });
  });
  describe("付け替えの印", () => {
    it("期限の UNIX 秒を、利用者のメタデータ TsunagiLock に書く資格情報で PUT し、読み直して確かめる", async () => {
      state.fetch
        .mockResolvedValueOnce(new Response("", { status: 200 }))
        .mockResolvedValueOnce(new Response("1800000000", { status: 200 }));
      await backend().lockStudy(id, 1800000000);
      const [url, init] = state.fetch.mock.calls[0]!;
      expect(url).toBe(`http://pacs.example.org/studies/${id}/metadata/TsunagiLock`);
      expect(init.method).toBe("PUT");
      expect(init.body).toBe("1800000000");
      expect(init.headers.authorization).toBe(`Basic ${Buffer.from("writer:synthetic-write").toString("base64")}`);
      const [checkUrl, checkInit] = state.fetch.mock.calls[1]!;
      expect(checkUrl).toBe(`http://pacs.example.org/studies/${id}/metadata/TsunagiLock`);
      expect(checkInit.method).toBe("GET");
      expect(checkInit.headers.authorization).toBe(init.headers.authorization);
    });
    it.each([
      ["別の値", () => new Response("1700000000", { status: 200 })],
      ["読めない", () => new Response("", { status: 404 })]
    ])("PUT が成功しても、読み直した印が%sなら投げる", async (_label, readBack) => {
      state.fetch.mockResolvedValueOnce(new Response("", { status: 200 })).mockResolvedValueOnce(readBack());
      await expect(backend().lockStudy(id, 1800000000)).rejects.toThrow("読み直すと値が違います");
    });
    it("Orthanc に印の名前（UserMetadata）が無ければ、設定の要ることを知らせて投げる", async () => {
      state.fetch.mockResolvedValueOnce(new Response("", { status: 404 }));
      await expect(backend().lockStudy(id, 1800000000)).rejects.toThrow("UserMetadata に TsunagiLock が要る");
    });
    it.each([0, -1, 1.5, Number.NaN])("期限 %s は送らない", async (until) => {
      await expect(backend().lockStudy(id, until)).rejects.toBeInstanceOf(BackendError);
      expect(state.fetch).not.toHaveBeenCalled();
    });
    it("通信が切れたら、結果不明ではなく書き換えない誤りにする", async () => {
      state.fetch.mockRejectedValueOnce(new Error("synthetic transport failure"));
      const error = await backend().lockStudy(id, 1800000000).catch(e => e);
      expect(error).toBeInstanceOf(BackendError);
      expect(error).not.toBeInstanceOf(BackendUnknownError);
    });
    it("外すのは DELETE。検査か印がもう無い（404）ときは何もしない", async () => {
      state.fetch.mockResolvedValueOnce(new Response("", { status: 404 }));
      await backend().unlockStudy(id);
      const [url, init] = state.fetch.mock.calls[0]!;
      expect(url).toBe(`http://pacs.example.org/studies/${id}/metadata/TsunagiLock`);
      expect(init.method).toBe("DELETE");
      state.fetch.mockResolvedValueOnce(new Response("", { status: 403 }));
      await expect(backend().unlockStudy(id)).rejects.toBeInstanceOf(BackendError);
    });
  });
  it.each([302, 502, 503, 504])("状態 %i は結果不明", async (status) => {
    state.fetch.mockResolvedValue(new Response("", { status }));
    await expect(backend().modifyStudyKeepingUids(id, {})).rejects.toBeInstanceOf(BackendUnknownError);
  });
  it("通信の切れと時間切れは結果不明", async () => {
    state.fetch.mockRejectedValue(new Error("synthetic transport failure"));
    await expect(backend().modifyStudyKeepingUids(id, {})).rejects.toBeInstanceOf(BackendUnknownError);
  });
  it.each([{}, { ID: "bad" }])("応答 ID が読めなければ結果不明", async (body) => {
    state.fetch.mockResolvedValue(Response.json(body));
    await expect(backend().modifyStudyKeepingUids(id, {})).rejects.toBeInstanceOf(BackendUnknownError);
  });
  it("400 の理由は秘密を写さず、OverwriteInstances の設定を知らせる", async () => {
    state.fetch.mockResolvedValue(new Response("OverwriteInstances synthetic-sensitive-value", { status: 400 }));
    await expect(backend().modifyStudyKeepingUids(id, {})).rejects.toThrow("OverwriteInstances が要る");
    state.fetch.mockResolvedValue(new Response("synthetic-sensitive-value", { status: 400 }));
    try {
      await backend().modifyStudyKeepingUids(id, {});
      throw new Error("断られなかった");
    } catch (e) {
      expect(e).toBeInstanceOf(BackendError);
      expect((e as Error).message).not.toContain("synthetic-sensitive-value");
    }
  });
});

it("全画像の5つの値と UID の組を instances-tags から読む", async () => {
  state.fetch.mockResolvedValue(Response.json({
    one: {
      PatientID: "P1",
      PatientName: "F^G",
      PatientBirthDate: "20000101",
      PatientSex: "M",
      AccessionNumber: "A1",
      StudyInstanceUID: "1.2",
      SeriesInstanceUID: "1.2.1",
      SOPInstanceUID: "1.2.1.1",
      SpecificCharacterSet: "ISO_IR 192"
    }
  }));
  expect(await backend().studyInstanceTags(id)).toEqual([
    {
      PatientID: "P1",
      PatientName: "F^G",
      PatientBirthDate: "20000101",
      PatientSex: "M",
      AccessionNumber: "A1",
      StudyInstanceUID: "1.2",
      SeriesInstanceUID: "1.2.1",
      SOPInstanceUID: "1.2.1.1",
      SpecificCharacterSet: "ISO_IR 192"
    }
  ]);
  expect(state.fetch.mock.calls[0]![0]).toBe(`http://pacs.example.org/studies/${id}/instances-tags?simplify`);
  expect(state.fetch.mock.calls[0]![1].headers.authorization).toBe(`Basic ${Buffer.from("reader:synthetic-read").toString("base64")}`);
});
it.each([
  [{ ID: id, IsStable: true }, true],
  [{ ID: id, IsStable: false }, false],
  [{ ID: id, IsStable: "true" }, false],
  [{ ID: id }, false]
])("届き終えたかは IsStable が true のときだけ（%j）", async (body, stable) => {
  state.fetch.mockResolvedValue(Response.json(body));
  expect(await backend().studyIsStable(id)).toBe(stable);
  expect(state.fetch.mock.calls[0]![0]).toBe(`http://pacs.example.org/studies/${id}`);
});
it("届き終えたかを見る検査の ID の形を確かめる", async () => {
  await expect(backend().studyIsStable("../x")).rejects.toMatchObject({ status: 400 });
  expect(state.fetch).not.toHaveBeenCalled();
});
