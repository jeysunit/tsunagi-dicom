import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockBackend, restoreMockStudies, duplicateMockStudy } from "@/lib/backend/mock";
import { BackendUnknownError, BackendError } from "@/lib/backend/types";
import type { AuditEntryInput } from "@/lib/audit";
import { enqueue, processMessage, recordReceiverEvent } from "@/lib/hl7/apply";
const a40 = readFileSync("tests/fixtures/hl7/a40.hl7").toString();
const a08 = readFileSync("tests/fixtures/hl7/a08.hl7").toString();
const orm = readFileSync("tests/fixtures/hl7/orm.hl7").toString();
let backend = createMockBackend();
let rows: AuditEntryInput[] = [];
const audit = async (row: AuditEntryInput) => {
  rows.push(row);
};
const send = (s: string) => processMessage(Buffer.from(s), "192.0.2.1", backend, audit, {
  readHistory: async () => rows,
  issuer: "RIS_EMU",
  allowWrite: true
});
const first = async () => (await backend.searchStudies()).studies[0]!;
beforeEach(() => {
  restoreMockStudies();
  backend = createMockBackend();
  rows = [];
});

describe("HL7 の反映と監査", () => {
  it("A40 は元の検査を残さず、患者と氏名を替え、UID を保つ", async () => {
    const study = await first();
    const oldId = (await backend.lookupStudyIds(study.studyInstanceUid))[0]!;
    const series = await backend.searchSeries(study.studyInstanceUid);
    const instances = await backend.searchInstances(study.studyInstanceUid, series[0]!.seriesInstanceUid);
    const ack = await send(a40.replace("ER2026102400", study.patientId));
    expect(ack).toContain("MSA|AA|");
    expect(await backend.findStudiesByPatientId(study.patientId)).toEqual([]);
    const newId = (await backend.lookupStudyIds(study.studyInstanceUid))[0]!;
    expect(newId).not.toBe(oldId);
    expect(await backend.studyPatient(oldId)).toBeNull();
    expect(await backend.studyPatient(newId)).toMatchObject({
      PatientID: "P000001",
      PatientName: "TANAKA^HIROSHI=田中^博=タナカ^ヒロシ"
    });
    expect(await backend.searchSeries(study.studyInstanceUid)).toEqual(series);
    expect((await backend.searchInstances(study.studyInstanceUid, series[0]!.seriesInstanceUid)).map((x) => x.sopInstanceUid)).toEqual(
      instances.map((x) => x.sopInstanceUid)
    );
    const request = rows.find((r) => r.detail?.event === "request" && r.studyInstanceUid === study.studyInstanceUid)!;
    const result = rows.find((r) => r.detail?.event === "result" && r.studyInstanceUid === study.studyInstanceUid)!;
    expect(result.detail).toMatchObject({
      writeId: request.detail!.writeId,
      oldOrthancId: oldId,
      newOrthancId: newId,
      StudyInstanceUID: study.studyInstanceUid,
      before: expect.arrayContaining([
        expect.objectContaining({ PatientID: study.patientId, PatientName: study.patientName })
      ]),
      after: expect.arrayContaining([
        expect.objectContaining({
          PatientID: "P000001",
          PatientName: "TANAKA^HIROSHI=田中^博=タナカ^ヒロシ"
        })
      ])
    });
    expect(request).toMatchObject({
      actorId: "hl7-receiver",
      actorRole: "system",
      authMode: "hl7",
      action: "hl7",
      sourceAddressUnverified: "192.0.2.1"
    });
    expect(await send(a40.replace("ER2026102400", study.patientId))).toContain("MSA|AA|");
    expect(rows.at(-1)?.detail?.count).toBe(rows.filter(r => r.detail?.event === "request").length);
  });
  it.each([a40, a08, orm])("検査が無ければ AA と件数 0", async (message) => {
    expect(await send(message)).toContain("MSA|AA|");
    expect(rows.map(r => r.detail?.event)).toEqual(["received", "ack"]);
    expect(rows.at(-1)?.detail).toMatchObject({ event: "ack", count: 0 });
  });
  it("替え先の患者がある場合も 4 つの患者タグを送り、生年月日の空は保つ", async () => {
    const studies = (await backend.searchStudies()).studies;
    const source = studies[0]!;
    const target = studies.find((s) => s.patientId !== source.patientId)!;
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
    const text = a40.replace("ER2026102400", source.patientId).replace("P000001", target.patientId).replace("19980312", "").replace(
      "TANAKA^HIROSHI^^^^^L^A~田中^博^^^^^L^I~タナカ^ヒロシ^^^^^L^P",
      ""
    ).replace(
      "|M\r",
      "|U\r"
    );
    expect(await send(text)).toContain("MSA|AA|");
    expect(modify.mock.calls[0]![1]).toMatchObject({
      PatientID: target.patientId,
      PatientBirthDate: target.patientBirthDate,
      PatientName: target.patientName,
      PatientSex: target.patientSex
    });
  });
  it("A08 の氏名だけの変更は患者 ID・生年月日・UID を保つ", async () => {
    const study = await first();
    const id = (await backend.lookupStudyIds(study.studyInstanceUid))[0]!;
    const before = await backend.studyPatient(id);
    expect(await send(a08.replace("P000001", study.patientId).replace("19980312", "").replace("|M\r", "|U\r"))).toContain("MSA|AA|");
    expect(await backend.studyPatient(id)).toEqual({ ...before, PatientName: "TANAKA^HIROSHI=田中^博=タナカ^ヒロシ" });
  });
  it("ORM は受付番号を入れ、同じ番号の再送は書き換えない", async () => {
    const study = await first();
    const id = (await backend.lookupStudyIds(study.studyInstanceUid))[0]!;
    await backend.modifyStudyKeepingUids(id, { AccessionNumber: "" }, { removeSource: false });
    const message = orm.replace("P000001", study.patientId).replace("2.25.67256859653214869994870466343258677753", study.studyInstanceUid);
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
    expect(await send(message)).toContain("MSA|AA|");
    expect((await backend.searchStudies()).studies.find((s) => s.studyInstanceUid === study.studyInstanceUid)?.accessionNumber).toBe(
      "RE202610210001"
    );
    expect(await send(message)).toContain("MSA|AA|");
    expect(modify).toHaveBeenCalledTimes(1);
    expect(await backend.lookupStudyIds(study.studyInstanceUid)).toEqual([id]);
  });
  it.each(["patient", "accession", "duplicate"])("ORM の不一致・重複 %s は AE", async (mode) => {
    const study = await first();
    if (mode === "duplicate") {
      duplicateMockStudy(study.studyInstanceUid);
    }
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
    const message = orm.replace("P000001", mode === "patient" ? "DIFFERENT" : study.patientId).replace(
      "2.25.67256859653214869994870466343258677753",
      study.studyInstanceUid
    );
    expect(await send(message)).toContain("MSA|AE|");
    expect(modify).not.toHaveBeenCalled();
  });
  it("request の記録が失敗したら Orthanc を呼ばない", async () => {
    const study = await first();
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
    const failingAudit = async (row: AuditEntryInput) => {
      if (row.detail?.event === "request") {
        throw new Error("記録できない");
      }
      await audit(row);
    };
    expect(await processMessage(Buffer.from(a40.replace("ER2026102400", study.patientId)), "192.0.2.1", backend, failingAudit, {
      readHistory: async () => rows,
      issuer: "RIS_EMU",
      allowWrite: true
    })).toContain("MSA|AE|");
    expect(modify).not.toHaveBeenCalled();
  });
  it.each([new BackendUnknownError(), new BackendError("断られた")])("途中の失敗で止めて result を残す", async (error) => {
    const study = await first();
    const id = (await backend.lookupStudyIds(study.studyInstanceUid))[0]!;
    vi.spyOn(backend, "findStudiesByPatientId").mockImplementation(async (p) => p === study.patientId ? [id, id] : []);
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids").mockRejectedValue(error);
    expect(await send(a40.replace("ER2026102400", study.patientId))).toContain("MSA|AE|");
    expect(modify).toHaveBeenCalledTimes(1);
    expect(rows.find((r) => r.detail?.event === "result")?.outcome).toBe(error instanceof BackendUnknownError ? "unknown" : "failed");
  });
  it("複数の検査の途中で失敗しても、先に終えた結果と件数を残す", async () => {
    const study = await first();
    const id = (await backend.lookupStudyIds(study.studyInstanceUid))[0]!;
    const originalTags = await backend.studyInstanceTags(id);
    const readTags = backend.studyInstanceTags.bind(backend);
    vi.spyOn(backend, "findStudiesByPatientId").mockImplementation(async (p) => p === study.patientId ? [id, "second", "third"] : []);
    vi.spyOn(backend, "studyInstanceTags").mockImplementation(
      async (candidate) => candidate === "second" || candidate === "third" ? originalTags : readTags(candidate)
    );
    const originalModify = backend.modifyStudyKeepingUids.bind(backend);
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids")
      .mockImplementationOnce(originalModify)
      .mockRejectedValue(new BackendError("失敗"));
    expect(await send(a40.replace("ER2026102400", study.patientId))).toContain("MSA|AE|");
    expect(modify).toHaveBeenCalledTimes(2);
    expect(rows.filter((r) => r.detail?.event === "result").map((r) => r.outcome)).toEqual(["success", "failed"]);
    expect(rows.at(-1)?.detail).toMatchObject({ event: "ack", count: 1 });
  });
  it("AE の値の誤りでも検索と書き換えを呼ばない", async () => {
    const find = vi.spyOn(backend, "findStudiesByPatientId");
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
    expect(await send(a40.replace("P000001", "P*"))).toContain("MSA|AE|");
    expect(find).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
    expect(rows.at(-1)?.detail?.event).toBe("ack");
  });
  it("旧い患者 ID と新しい患者 ID が同じ A40 は、書き換えずに AE", async () => {
    const study = await first();
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
    const ack = await send(a40.replace("ER2026102400", study.patientId).replace("P000001", study.patientId));
    expect(ack).toContain("MSA|AE|");
    expect(modify).not.toHaveBeenCalled();
    expect(await backend.findStudiesByPatientId(study.patientId)).not.toEqual([]);
  });
  it.each([
    "BAD",
    a40.replace("ADT^A40", "ADT^A03"),
    orm.replace("ORC|NW", "ORC|CA"),
    a40.replace("TANAKA", "\x1b[31m"),
    a40.replace("RIS_EMU", "\x1b[31m")
  ])("AR は rejected だけを残す", async (message) => {
    expect(await send(message)).toContain("MSA|AR|");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied", detail: { event: "rejected" } });
    expect(JSON.stringify(rows)).not.toContain("\u001b");
  });
  it.each(["\\X1B\\", "\x1b"])("制御文字の理由を監査と ACK で見える形にする", async (invalid) => {
    const ack = await send(a40.replace("TANAKA", invalid));
    expect(ack).toContain("MSA|AR|");
    expect(ack).toContain("\\u001B");
    expect(rows[0]!.detail!.reason).toContain("\\u001B");
    expect(ack.includes(String.fromCharCode(27))).toBe(false);
  });
  it.each(["refused", "oversize", "timeout", "framing"] as const)("受け口の %s は denied の 1 行", async (event) => {
    await recordReceiverEvent("192.0.2.1", event, audit);
    expect(rows).toMatchObject([{ outcome: "denied", detail: { event } }]);
  });
  it("FIFO は処理が重ならず、失敗後も続く", async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = enqueue(async () => {
      order.push(1);
      await gate;
      order.push(2);
      throw new Error("失敗");
    });
    const handled = a.catch(() => undefined);
    const b = enqueue(async () => {
      order.push(3);
    });
    await Promise.resolve();
    expect(order).toEqual([1]);
    release();
    await handled;
    await b;
    expect(order).toEqual([1, 2, 3]);
  });
});
