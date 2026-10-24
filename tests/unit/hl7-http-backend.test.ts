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
  it("元の画像は、UID の組で名指ししたものだけを画像の ID で 1 枚ずつ、書く資格情報で消す", async () => {
    const tag = (sop: string) => ({ PatientID: "T1", StudyInstanceUID: "1.2", SeriesInstanceUID: "1.2.3", SOPInstanceUID: sop });
    const one = "00000000-00000000-00000000-00000000-0000000a";
    const late = "00000000-00000000-00000000-00000000-0000000b";
    state.fetch
      .mockResolvedValueOnce(Response.json({ [one]: tag("1.2.3.1"), [late]: tag("1.2.3.2") }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    await backend().deleteStudyInstances(id, [{ ...tag("1.2.3.1"), PatientName: "", PatientBirthDate: "", PatientSex: "", AccessionNumber: "", SpecificCharacterSet: "" }]);
    expect(state.fetch).toHaveBeenCalledTimes(2);
    expect(state.fetch.mock.calls[0]![0]).toBe(`http://pacs.example.org/studies/${id}/instances-tags?simplify`);
    const [url, init] = state.fetch.mock.calls[1]!;
    expect(url).toBe(`http://pacs.example.org/instances/${one}`);
    expect(init.method).toBe("DELETE");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("writer:synthetic-write").toString("base64")}`);
  });
  it.each([[502, BackendUnknownError], [403, BackendError]])("画像の削除の状態 %i を投げる", async (status, error) => {
    const one = "00000000-00000000-00000000-00000000-0000000a";
    const tag = { PatientID: "T1", StudyInstanceUID: "1.2", SeriesInstanceUID: "1.2.3", SOPInstanceUID: "1.2.3.1" };
    state.fetch
      .mockResolvedValueOnce(Response.json({ [one]: tag }))
      .mockResolvedValueOnce(new Response("", { status }));
    const named = { ...tag, PatientName: "", PatientBirthDate: "", PatientSex: "", AccessionNumber: "", SpecificCharacterSet: "" };
    await expect(backend().deleteStudyInstances(id, [named])).rejects.toBeInstanceOf(error);
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
