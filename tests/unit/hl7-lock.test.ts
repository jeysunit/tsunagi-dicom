import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntryInput } from "@/lib/audit";
import { processMessage, type ProcessOptions } from "@/lib/hl7/apply";
import { sweepArrivals } from "@/lib/hl7/sweep";
import { createFakeOrthanc, type FakeOrthanc } from "./helpers/fake-orthanc";

// 付け替えの印（design.md §15.4）：患者 ID の変わる書き換えの前に元の検査へ印を付け、Orthanc の Lua に同じ
// StudyInstanceUID の C-STORE を断らせる。消す前に、書き換えた画像の ModifiedFrom が元の画像の ID と同じかを確かめる。
const A40 = readFileSync("tests/fixtures/hl7/a40.hl7").toString();
const A08 = readFileSync("tests/fixtures/hl7/a08.hl7").toString();
const TEMP = "ER2026102400";
const STUDY = "2.25.100";
let seq = 0;
const a40 = (from: string, to: string) =>
  A40.replace("ER2026102400", from).replace("P000001", to).replace("20261024201530A40A", `A40${++seq}`);

let orthanc: FakeOrthanc;
let rows: AuditEntryInput[];
const audit = async (row: AuditEntryInput) => {
  rows.push(row);
};
const options = (extra: ProcessOptions = {}) => ({ readHistory: async () => rows, issuer: "RIS_EMU", allowWrite: true, pollMs: 1, ...extra });
const send = (text: string, extra: ProcessOptions = {}) => processMessage(Buffer.from(text), "192.0.2.1", orthanc.backend, audit, options(extra));
const sweep = (extra: ProcessOptions = {}) => sweepArrivals(orthanc.backend, audit, options(extra));
const temp = (uid = STUDY, extra: Record<string, string> = {}) =>
  orthanc.add({ PatientID: TEMP, PatientName: "UNKNOWN^MALE", PatientSex: "M", StudyInstanceUID: uid, ...extra });
const results = () => rows.filter(r => r.detail?.event === "result" || r.detail?.event === "reconcile");

beforeEach(() => {
  orthanc = createFakeOrthanc();
  rows = [];
  seq = 0;
});

describe("付け替えの印", () => {
  it("A40 は書き換えの前に元の検査へ印を付け、元を消した後に外す", async () => {
    temp();
    const source = orthanc.studyId(TEMP, STUDY);
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(orthanc.events).toEqual([`lock:${source}`, `modify:${source}`, `delete:${source}`, `unlock:${source}`]);
    expect(orthanc.locks.size).toBe(0);
  });

  it("印の間は、元の患者 ID でも統合した先の患者 ID でも、同じ StudyInstanceUID の C-STORE を断り、外した後は受ける", async () => {
    temp();
    const answers: string[] = [];
    orthanc.next.beforeModify = () => {
      answers.push(orthanc.cstore({ PatientID: TEMP, StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.9.1` }));
      answers.push(orthanc.cstore({ PatientID: "P000001", StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.9.2` }));
      // 別の検査は断らない
      answers.push(orthanc.cstore({ PatientID: TEMP, StudyInstanceUID: "2.25.200" }));
    };
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(answers).toEqual(["refused", "refused", "stored"]);
    expect(results().at(-1)).toMatchObject({ outcome: "success", detail: { partial: false } });
    // 外した後の送り直しは受ける（仮の患者 ID のまま、後から届いた画像として残る）
    expect(orthanc.cstore({ PatientID: TEMP, StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.9.1` })).toBe("stored");
  });

  it("期限の切れた印では断らない（BFF が途中で止まっても、印は期限で切れる）", async () => {
    temp();
    orthanc.locks.set(orthanc.studyId(TEMP, STUDY), Math.floor(Date.now() / 1000) - 1);
    expect(orthanc.cstore({ PatientID: TEMP, StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.9.1` })).toBe("stored");
  });

  it("印を付けられなければ（Orthanc に設定が無い）、書き換えも記録もせずに AE を返す", async () => {
    temp();
    orthanc.lockRefused = true;
    const ack = await send(a40(TEMP, "P000001"));
    expect(ack).toContain("MSA|AE|");
    expect(ack).toContain("付け替えの印");
    expect(orthanc.modifyCalls).toHaveLength(0);
    expect(rows.some(r => r.detail?.event === "request")).toBe(false);
  });

  it("患者 ID の変わらない A08 には印を付けない", async () => {
    orthanc.add({ PatientID: "P000001", PatientName: "OLD^NAME", StudyInstanceUID: STUDY });
    expect(await send(A08)).toContain("MSA|AA|");
    expect(orthanc.modifyCalls).toHaveLength(1);
    expect(orthanc.events.filter(e => e.startsWith("lock:"))).toEqual([]);
  });

  it("仕事が長ければ、期限の半分を過ぎるたびに印を付け直す", async () => {
    temp();
    orthanc.next.state = "Running";
    const status = orthanc.backend.jobStatus.bind(orthanc.backend);
    let polls = 0;
    vi.spyOn(orthanc.backend, "jobStatus").mockImplementation(async (jobId) => {
      if (++polls === 30) {
        orthanc.jobs.set(jobId, "Success");
      }
      return status(jobId);
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 20, pollMs: 2 })).toContain("MSA|AA|");
    expect(orthanc.events.filter(e => e.startsWith("lock:")).length).toBeGreaterThan(2);
    expect(orthanc.events.at(-1)).toMatch(/^unlock:/);
  });

  it("書き換えが失敗しても印を外す", async () => {
    temp();
    orthanc.next.state = "Failure";
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AE|");
    expect(orthanc.events.at(-1)).toBe(`unlock:${orthanc.studyId(TEMP, STUDY)}`);
  });

  it("印を外せなくても書き換えの結果は変えない（期限で切れる）", async () => {
    temp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(orthanc.backend, "unlockStudy").mockRejectedValue(new Error("synthetic"));
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("付け替えの印を外せなかった"));
    warn.mockRestore();
  });

  it("見回りの書き換えでも、仮の患者の検査に印を付け、最中の C-STORE を断る", async () => {
    temp();
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    const source = orthanc.studyId(TEMP, STUDY);
    orthanc.events.length = 0;
    let answer = "";
    orthanc.next.beforeModify = () => {
      answer = orthanc.cstore({ PatientID: TEMP, StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.3.1` });
    };
    expect(await sweep()).toEqual({ count: 1, skipped: 0 });
    expect(answer).toBe("refused");
    expect(orthanc.events).toEqual([`lock:${source}`, `modify:${source}`, `delete:${source}`, `unlock:${source}`]);
  });
});

describe("写しの確かめ（ModifiedFrom）", () => {
  it("書き換えた画像が REST で同じ UID の別の画像に置き換わっていれば、元を消さずに部分反映で止める", async () => {
    temp();
    temp(STUDY, { SOPInstanceUID: `${STUDY}.1.9` });
    const origins = orthanc.backend.studyInstanceOrigins.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "studyInstanceOrigins").mockImplementationOnce(async (id) => {
      // 写しの後に、統合した先の患者 ID・同じ値・同じ UID で、中身の違う画像が REST で届く（OverwriteInstances で置き換わる）
      const copy = orthanc.instances.find(i => i.PatientID === "P000001")!;
      orthanc.restStore({ ...copy });
      return origins(id);
    });
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AE|");
    expect(orthanc.deleteCalls).toHaveLength(0);
    expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(2);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, foreignCopies: true, state: "Success" } });
    expect(orthanc.events.at(-1)).toMatch(/^unlock:/);
  });

  it("元の画像の ID を持たない前の版の記録では、照らし合わせでも元を消さない", async () => {
    temp();
    const files = orthanc.backend.studyInstanceFiles.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "studyInstanceFiles").mockImplementationOnce(async (id) => {
      const { since, files: f } = await files(id);
      return { since, files: f };
    });
    // 仕事の終わりを読めずに止まる（結果不明）
    orthanc.next.state = "Running";
    expect(await send(a40(TEMP, "P000001"), { jobTimeoutMs: 5 })).toContain("MSA|AE|");
    for (const [jobId] of orthanc.jobs) orthanc.jobs.set(jobId, "Success");
    expect(await sweep()).toMatchObject({ blocked: "結果の分からない書き換えがある" });
    expect(orthanc.deleteCalls).toHaveLength(0);
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, foreignCopies: true } });
  });

  it("照らし合わせで元を消すときも、消す間は印を付ける", async () => {
    temp();
    orthanc.next.state = "Running";
    expect(await send(a40(TEMP, "P000001"), { jobTimeoutMs: 5 })).toContain("MSA|AE|");
    for (const [jobId] of orthanc.jobs) orthanc.jobs.set(jobId, "Success");
    const source = orthanc.studyId(TEMP, STUDY);
    orthanc.events.length = 0;
    expect(await sweep()).toEqual({ count: 0, skipped: 0 });
    expect(orthanc.events).toEqual([`lock:${source}`, `delete:${source}`, `unlock:${source}`]);
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "success" });
  });
});
