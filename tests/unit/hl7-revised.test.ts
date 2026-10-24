/* eslint-disable no-control-regex -- ASCII と制御文字の検証。 */
import { readFileSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { createMockBackend, restoreMockStudies, simulateMockHl7 } from "@/lib/backend/mock";
import { processMessage, type HistoryRow, type ProcessOptions, unresolved, verify } from "@/lib/hl7/apply";
import { parseMessage } from "@/lib/hl7/message";
import { extractUpdate } from "@/lib/hl7/update";
import { BackendUnknownError } from "@/lib/backend/types";
const a08 = readFileSync("tests/fixtures/hl7/a08.hl7", "utf8");
const a40 = readFileSync("tests/fixtures/hl7/a40.hl7", "utf8");
let backend = createMockBackend();
let rows: HistoryRow[] = [];
let sequence = 0;
const audit = async (r: HistoryRow) => {
  rows.push({ ...r, occurredAt: new Date() });
};
const send = (s: string, options: ProcessOptions = {}) => processMessage(Buffer.from(s), "192.0.2.1", backend, audit, {
  readHistory: async () => rows,
  issuer: "RIS_EMU",
  allowWrite: true,
  pollMs: 1,
  jobTimeoutMs: 2,
  ...options
});
const fresh = (s: string) => change(s, "MSH", 9, `T${++sequence}`);
const change = (s: string, segment: string, n: number, v: string) => s.split("\r").map(line => {
  const f = line.split("|");
  if (f[0] === segment) {
    f[n] = v;
  }
  return f.join("|");
}).join("\r");
const first = async () => (await backend.searchStudies()).studies[0]!;
const update = async () => {
  const study = await first();
  return fresh(a08.replace("P000001", study.patientId));
};
beforeEach(() => {
  restoreMockStudies();
  backend = createMockBackend();
  rows = [];
  sequence = 0;
});
it.each(["M~F", "M&F", "M^F"])("性別の欄の形 %s は AR", v => expect(parseMessage(Buffer.from(change(a08, "PID", 8, v))).ok).toBe(false));
it.each(["", "a".repeat(21), "A B", "A^B"])(
  "MSH-10 %s は AR",
  v => expect(parseMessage(Buffer.from(change(a08, "MSH", 9, v))).ok).toBe(false)
);
it.each(["ADT^A08^ADT_A39", "ADT^A40^ADT_A08", "ORM^O01^ADT_A01"])("MSH-9 の組 %s は AR", v => {
  const p = parseMessage(Buffer.from(change(a08, "MSH", 8, v)));
  expect(p.ok).toBe(true);
  if (p.ok) {
    expect(extractUpdate(p.msg)).toMatchObject({ ok: false, code: "AR" });
  }
});
it.each(["M\\T\\F", '""'])("値 %s は AE", v => {
  const p = parseMessage(Buffer.from(change(a08, "PID", 8, v)));
  if (!p.ok) {
    throw Error(p.reason);
  }
  expect(extractUpdate(p.msg)).toMatchObject({ ok: false, code: "AE" });
});

it("PN は並べ替えた後の ^ を含めて64字", () => {
  for (const [length, ok] of [[62, true], [63, false]] as const) {
    const p = parseMessage(Buffer.from(change(a08, "PID", 5, `${"A".repeat(length)}^B`)));
    if (!p.ok) {
      throw Error(p.reason);
    }
    expect(extractUpdate(p.msg).ok).toBe(ok);
  }
});
it.each([
  "P1^^^OTHER^PI",
  "P1^^^RIS_EMU&1.2&ISO^PI",
  "P1^^^RIS_EMU^PI~P2^^^RIS_EMU^PI"
])("発番元の選択 %s は AE", v => {
  const p = parseMessage(Buffer.from(change(a08, "PID", 3, v)));
  if (!p.ok) {
    throw Error(p.reason);
  }
  expect(extractUpdate(p.msg)).toMatchObject({ ok: false, code: "AE" });
});

it("PID が2つなら AR", async () => expect(await send(a40 + "PID|1\r")).toContain("MSA|AR|"));

it(
  "ASCII は MSH-18 が空でも受ける",
  () => expect(parseMessage(Buffer.from(change(a08.replace(/[^\x00-\x7f]/g, "A"), "MSH", 17, ""))).ok).toBe(true)
);
it.each(["A^^^^^^^A~B^^^^^^^A", "A^^^^^^^A~B"])(
  "氏名の種類の重複・混在は AR",
  async (name) => expect(await send(change(a08, "PID", 5, name))).toContain("MSA|AR|")
);

it("エスケープした ^ は氏名の成分として AE", async () => expect(await send(change(a08, "PID", 5, "O\\S\\BRIEN"))).toContain("MSA|AE|"));

it("received は最初の Orthanc 読み取りより前", async () => {
  vi.spyOn(backend, "findStudiesByPatientId").mockImplementation(async () => {
    expect(rows[0]?.detail?.event).toBe("received");
    return [];
  });
  expect(await send(a08)).toContain("MSA|AA|");
});

it("同じ A08 の再送は後の氏名を巻き戻さず Orthanc を呼ばない", async () => {
  const message = await update();
  expect(await send(message)).toContain("MSA|AA|");
  expect(await send(fresh(change(message, "PID", 5, "LATER^NAME")))).toContain("MSA|AA|");
  const read = vi.spyOn(backend, "findStudiesByPatientId");
  expect(await send(message)).toContain("MSA|AA|");
  expect(read).not.toHaveBeenCalled();
  expect((await first()).patientName).toBe("LATER^NAME");
});

it("同じ MSH-10 の違う本文は AR", async () => {
  const message = await update();
  await send(message);
  const read = vi.spyOn(backend, "findStudiesByPatientId");
  expect(await send(change(message, "PID", 5, "OTHER"))).toContain("MSA|AR|");
  expect(read).not.toHaveBeenCalled();
});

it("7日より古い received は重複としない", async () => {
  const message = await update();
  await send(message);
  rows[0]!.occurredAt = new Date(Date.now() - 8 * 86400000);
  expect(await send(message)).toContain("MSA|AA|");
  expect(rows.filter(r => r.detail?.event === "received")).toHaveLength(2);
});

it("received の記録失敗は Orthanc を読まない", async () => {
  const read = vi.spyOn(backend, "findStudiesByPatientId");
  expect(await processMessage(Buffer.from(a08), "192.0.2.1", backend, async () => {
    throw Error("audit");
  }, { issuer: "RIS_EMU", readHistory: async () => [] })).toContain("MSA|AE|");
  expect(read).not.toHaveBeenCalled();
});

it("検証モードの書き込みを止める", async () => {
  const message = await update();
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(message, { allowWrite: false })).toContain("MSA|AE|");
  expect(modify).not.toHaveBeenCalled();
});

it("job の時間切れは unknown、Running は後続を止め、Success は照合で解く", async () => {
  const message = await update();
  const original = backend.jobStatus.bind(backend);
  const job = vi.spyOn(backend, "jobStatus");
  job.mockImplementation(async (id) => {
    const result = await original(id);
    return result && { ...result, state: "Running" };
  });
  expect(await send(message)).toContain("MSA|AE|");
  expect(rows.find(r => r.detail?.event === "result")?.outcome).toBe("unknown");
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(fresh(message))).toContain("MSA|AE|");
  expect(modify).not.toHaveBeenCalled();
  job.mockImplementation(original);
  expect(await send(fresh(message))).toContain("MSA|AA|");
  expect(rows.some(r => r.detail?.event === "reconcile" && r.outcome === "success")).toBe(true);
});
it.each(["Success", "Failure"] as const)("%s でも1画像が前のままなら partial、後続を止める", async (state) => {
  const message = await update();
  const originalTags = backend.studyInstanceTags.bind(backend);
  const study = await first();
  const id = (await backend.lookupStudyIds(study.studyInstanceUid))[0]!;
  const before = await originalTags(id);
  const originalModify = backend.modifyStudyKeepingUids.bind(backend);
  let written = false;
  vi.spyOn(backend, "modifyStudyKeepingUids").mockImplementation(async (...args) => {
    const r = await originalModify(...args);
    written = true;
    return r;
  });
  vi.spyOn(backend, "studyInstanceTags").mockImplementation(async (id) => {
    const tags = await originalTags(id);
    if (written) {
      tags[0] = { ...tags[0]!, PatientName: before[0]!.PatientName };
    }
    return tags;
  });
  const originalJob = backend.jobStatus.bind(backend);
  vi.spyOn(backend, "jobStatus").mockImplementation(async (id) => {
    const j = await originalJob(id);
    return j && { ...j, state };
  });
  expect(await send(message)).toContain("MSA|AE|");
  expect(rows.find(r => r.detail?.event === "result")?.detail?.partial).toBe(true);
  expect(await send(fresh(message))).toContain("MSA|AE|");
});

it("Failure で全画像が前の値なら failed として解く", async () => {
  const message = await update();
  vi.spyOn(backend, "modifyStudyKeepingUids").mockResolvedValue({ jobId: "failed" });
  vi.spyOn(backend, "jobStatus").mockResolvedValue({
    id: "failed",
    state: "Failure",
    progress: 100,
    errorCode: 1,
    errorDescription: "",
    creationTime: "",
    completionTime: null
  });
  expect(await send(message)).toContain("MSA|AE|");
  expect(unresolved(rows)).toEqual([]);
  expect(rows.find(r => r.detail?.event === "result")).toMatchObject({ outcome: "failed", detail: { partial: false } });
});

it("job ID の無い要求は自動で解かない", async () => {
  const message = await update();
  vi.spyOn(backend, "modifyStudyKeepingUids").mockRejectedValue(new BackendUnknownError());
  await send(message);
  const job = vi.spyOn(backend, "jobStatus");
  expect(await send(fresh(message))).toContain("MSA|AE|");
  expect(job).not.toHaveBeenCalled();
  expect(unresolved(rows)).toHaveLength(1);
});

it("result 追記失敗は unresolved として残り次の受信で照合できる", async () => {
  const message = await update();
  const writer = async (r: HistoryRow) => {
    if (r.detail?.event === "result") {
      throw Error("audit");
    }
    await audit(r);
  };
  expect(
    await processMessage(
      Buffer.from(message),
      "192.0.2.1",
      backend,
      writer,
      { readHistory: async () => rows, issuer: "RIS_EMU", allowWrite: true }
    )
  ).toContain(
    "MSA|AE|"
  );
  expect(unresolved(rows)).toHaveLength(1);
  expect(await send(fresh(message))).toContain("MSA|AA|");
  expect(unresolved(rows)).toEqual([]);
});

it("received だけの再送は interrupted の AE で閉じる", async () => {
  const message = await update();
  await send(message);
  rows = rows.filter(r => r.detail?.event === "received");
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(message)).toContain("MSA|AE|");
  expect(rows.at(-1)?.detail).toMatchObject({ event: "ack", interrupted: true, code: "AE" });
  expect(modify).not.toHaveBeenCalled();
});

it("ISO_IR 192 以外に日本語を書かない", async () => {
  const message = await update();
  const read = backend.studyInstanceTags.bind(backend);
  vi.spyOn(backend, "studyInstanceTags").mockImplementation(
    async (id) => (await read(id)).map(t => ({ ...t, SpecificCharacterSet: "ISO_IR 100" }))
  );
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(message)).toContain("MSA|AE|");
  expect(modify).not.toHaveBeenCalled();
});

it("画像の UID の組が変われば値が同じでも一致にしない", async () => {
  const message = await update();
  await send(message);
  const d = unresolved(rows.filter(r => r.detail?.event !== "result"))[0]!;
  const read = backend.studyInstanceTags.bind(backend);
  vi.spyOn(backend, "studyInstanceTags").mockImplementation(
    async (id) => (await read(id)).map(t => ({ ...t, SeriesInstanceUID: "1.2.999" }))
  );
  expect(await verify(backend, d)).toMatchObject({ matchesAfter: false, matchesBefore: false });
});

it("替え先と違う属性の A40 は両方を保つ", async () => {
  const studies = (await backend.searchStudies()).studies;
  const source = studies[0]!, target = studies.find(s => s.patientId !== source.patientId)!;
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(a40.replace("ER2026102400", source.patientId).replace("P000001", target.patientId))).toContain("MSA|AE|");
  expect(modify).not.toHaveBeenCalled();
  expect((await backend.searchStudies()).studies).toEqual(studies);
});

it("dispatch を記録できなければ AE で job ID 不明のまま止める", async () => {
  const message = await update();
  const writer = async (r: HistoryRow) => {
    if (r.detail?.event === "dispatch") {
      throw Error("audit");
    }
    await audit(r);
  };
  expect(
    await processMessage(
      Buffer.from(message),
      "192.0.2.1",
      backend,
      writer,
      { readHistory: async () => rows, issuer: "RIS_EMU", allowWrite: true }
    )
  ).toContain(
    "MSA|AE|"
  );
  expect(rows.some(r => r.detail?.event === "dispatch")).toBe(false);
  expect(unresolved(rows)).toHaveLength(1);
  expect(await send(fresh(message))).toContain("MSA|AE|");
});

it("ack を記録できなければ途中で止まったメッセージとして AE で閉じる", async () => {
  const message = await update();
  const writer = async (r: HistoryRow) => {
    if (r.detail?.event === "ack") {
      throw Error("audit");
    }
    await audit(r);
  };
  expect(
    await processMessage(
      Buffer.from(message),
      "192.0.2.1",
      backend,
      writer,
      { readHistory: async () => rows, issuer: "RIS_EMU", allowWrite: true }
    )
  ).toContain(
    "MSA|AE|"
  );
  expect(rows.some(r => r.detail?.event === "ack")).toBe(false);
  expect(await send(message)).toContain("MSA|AE|");
  expect(rows.at(-1)?.detail?.interrupted).toBe(true);
});

it("A40 の旧い患者の検査で属性が違えば書かない", async () => {
  const study = await first();
  const original = backend.studyInstanceTags.bind(backend);
  vi.spyOn(backend, "studyInstanceTags").mockImplementation(async (id) => {
    const tags = await original(id);
    if (tags.length > 1) {
      tags[1] = { ...tags[1]!, PatientBirthDate: "20000101" };
    }
    return tags;
  });
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(a40.replace("ER2026102400", study.patientId))).toContain("MSA|AE|");
  expect(modify).not.toHaveBeenCalled();
});

it("英字だけなら ISO_IR 192 以外も書ける", async () => {
  const message = change(await update(), "PID", 5, "ASCII^NAME");
  const read = backend.studyInstanceTags.bind(backend);
  vi.spyOn(backend, "studyInstanceTags").mockImplementation(
    async (id) => (await read(id)).map(t => ({ ...t, SpecificCharacterSet: "ISO_IR 100" }))
  );
  expect(await send(message)).toContain("MSA|AA|");
});
it.each(["Running", "Failure", "partial", "timeout"])("モック自体で %s を再現できる", async (mode) => {
  const message = await update();
  simulateMockHl7(
    mode === "partial" ? { state: "Success", changedInstances: 1 }
      : mode === "timeout" ? { dispatchTimeout: true }
      : { state: mode as "Running" | "Failure" }
  );
  expect(await send(message)).toContain("MSA|AE|");
  const result = rows.find(r => r.detail?.event === "result")!;
  expect(result.outcome).toBe(mode === "Running" || mode === "timeout" ? "unknown" : "failed");
  if (mode === "partial") {
    expect(result.detail?.partial).toBe(true);
  }
  expect(unresolved(rows).length).toBe(mode === "Failure" ? 0 : 1);
});

it("仕事の読み取りに失敗しても前の値だけで failed に決めない", async () => {
  const message = await update();
  simulateMockHl7({ state: "Running", changedInstances: 0 });
  const { BackendError } = await import("@/lib/backend/types");
  vi.spyOn(backend, "jobStatus").mockRejectedValue(new BackendError("読めない"));
  expect(await send(message)).toContain("MSA|AE|");
  expect(rows.find(r => r.detail?.event === "result")?.outcome).toBe("unknown");
  expect(unresolved(rows)).toHaveLength(1);
});

it("Success でも全画像が前のままなら partial として後続を止める", async () => {
  const message = await update();
  simulateMockHl7({ state: "Success", changedInstances: 0 });
  expect(await send(message)).toContain("MSA|AE|");
  expect(rows.find(row => row.detail?.event === "result")).toMatchObject({
    outcome: "failed",
    detail: { partial: true, matchesBefore: true, matchesAfter: false },
  });
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(fresh(message))).toContain("MSA|AE|");
  expect(modify).not.toHaveBeenCalled();
  expect(unresolved(rows)).toHaveLength(1);
});

it("照合した Success でも予定と違えば partial を残す", async () => {
  const message = await update();
  simulateMockHl7({ state: "Running", changedInstances: 0 });
  expect(await send(message)).toContain("MSA|AE|");
  const original = backend.jobStatus.bind(backend);
  vi.spyOn(backend, "jobStatus").mockImplementation(async id => {
    const job = await original(id);
    return job && { ...job, state: "Success" };
  });
  const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
  expect(await send(fresh(message))).toContain("MSA|AE|");
  expect(rows.find(row => row.detail?.event === "reconcile")).toMatchObject({
    outcome: "failed", detail: { partial: true, matchesBefore: true },
  });
  expect(modify).not.toHaveBeenCalled();
  expect(unresolved(rows)).toHaveLength(1);
});

it("Failure で全画像が前のままなら次のメッセージを処理できる", async () => {
  const message = await update();
  simulateMockHl7({ state: "Failure", changedInstances: 0 });
  expect(await send(message)).toContain("MSA|AE|");
  expect(unresolved(rows)).toEqual([]);
  simulateMockHl7({ state: "Success" });
  expect(await send(fresh(message))).toContain("MSA|AA|");
});
