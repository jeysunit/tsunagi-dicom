import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntryInput } from "@/lib/audit";
import { BackendUnknownError } from "@/lib/backend/types";
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
// 期限をミリ秒まで縮めるので、時計のずれの許しは 0 にする（偽の Orthanc は同じ時計）
const options = (extra: ProcessOptions = {}) =>
  ({ readHistory: async () => rows, issuer: "RIS_EMU", allowWrite: true, pollMs: 1, lockClockToleranceMs: 0, ...extra });
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
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 60, pollMs: 4 })).toContain("MSA|AA|");
    expect(orthanc.events.filter(e => e.startsWith("lock:")).length).toBeGreaterThan(2);
    expect(orthanc.events.at(-1)).toMatch(/^unlock:/);
  });

  it("印を付ける前に、求めたことを監査の記録に残し、残せなければ印を付けない", async () => {
    temp();
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    const events = rows.map(r => r.detail?.event);
    expect(events.indexOf("lock")).toBeGreaterThan(-1);
    expect(events.indexOf("lock")).toBeLessThan(events.indexOf("request"));
    const lockRow = rows.find(r => r.detail?.event === "lock")!;
    expect(lockRow.detail?.writeId).toBe(rows.find(r => r.detail?.event === "request")!.detail?.writeId);

    // 記録に失敗すれば、印も書き換えも無い
    temp("2.25.300");
    const failing = async (row: AuditEntryInput) => {
      if (row.detail?.event === "lock") throw new Error("synthetic audit failure");
      rows.push(row);
    };
    const before = orthanc.events.length;
    const ack = await processMessage(Buffer.from(a40(TEMP, "P000002")), "192.0.2.1", orthanc.backend, failing, options());
    expect(ack).toContain("MSA|AE|");
    expect(orthanc.events.slice(before)).toEqual([]);
  });

  it("元を消す間も印を延ばし、延ばせなければ残りを消さずに部分反映で止める", async () => {
    temp();
    temp(STUDY, { SOPInstanceUID: `${STUDY}.1.9` });
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    let calls = 0;
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementation(async (id, until) => {
      if (++calls > 1) throw new Error("synthetic renew failure");
      return lockStudy(id, until);
    });
    // 期限 400 ミリ秒（時計の付け直しは 100 ミリ秒ごと）で、写しを確かめるのに 300 ミリ秒かかる：その間に付け直しが呼ばれて失敗する
    const origins = orthanc.backend.studyInstanceOrigins.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "studyInstanceOrigins").mockImplementation(async (id) => {
      await new Promise(r => setTimeout(r, 300));
      return origins(id);
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 400, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(calls).toBeGreaterThan(1);
    expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(2);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true, state: "Success" } });
    // 人が解くまで、照らし合わせも見回りも自動で解かない
    expect(await sweep()).toMatchObject({ blocked: "結果の分からない書き換えがある" });
    expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(2);
  });

  it("元を消す直前に印の期限が過ぎていれば（その間に C-STORE が入りえた）、付け直して続けずに部分反映で止める", async () => {
    temp();
    // 期限 200 ミリ秒で、写しを確かめる間に BFF が 300 ミリ秒止まる（時計の付け直しも動かない）：消す直前には必ず過ぎている。
    // 書き換えを始める前に切れると、書き換え自体を始めないので、止まるのは仕事の後にする
    const origins = orthanc.backend.studyInstanceOrigins.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "studyInstanceOrigins").mockImplementation(async (id) => {
      const stalled = Date.now() + 300;
      while (Date.now() < stalled) {
        // 止まった BFF の代わり（時計を動かさない）
      }
      return origins(id);
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 200, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(orthanc.modifyCalls).toHaveLength(1);
    expect(orthanc.deleteCalls).toHaveLength(0);
    expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(1);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("最後に消す間に印の期限が過ぎれば、消し終えても成功にせず部分反映で止める", async () => {
    temp();
    orthanc.next.duringDelete = () => {
      // 消す要求の答えを待つ間に BFF が 300 ミリ秒止まる（期限 200 ミリ秒。時計の付け直しも動かない）
      const stalled = Date.now() + 300;
      while (Date.now() < stalled) {
        // 止まった BFF の代わり
      }
    };
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 200, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(orthanc.deleteCalls).toHaveLength(1);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("消し終えた時に途中だった付け直しが後で失敗すれば、成功にせず部分反映で止める", async () => {
    temp();
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    let calls = 0;
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementation(async (id, until) => {
      if (++calls > 1) {
        // 時計の付け直しの答えが 300 ミリ秒後に失敗で返る
        await new Promise(r => setTimeout(r, 300));
        throw new Error("synthetic renew failure");
      }
      return lockStudy(id, until);
    });
    // 消す要求の答えを待つ間に、時計の付け直しが始まる（期限 200 ミリ秒。残りが半分を切った時計で）
    const remove = orthanc.backend.deleteStudyInstances.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "deleteStudyInstances").mockImplementation(async (...args) => {
      await remove(...args);
      for (let waited = 0; calls < 2 && waited < 180; waited += 5) await new Promise(r => setTimeout(r, 5));
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 200, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(calls).toBeGreaterThan(1);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("消した後の読み取りの失敗が、途中の付け直しの失敗より先に返っても、結果不明にせず部分反映で止める", async () => {
    temp();
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    let calls = 0;
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementation(async (id, until) => {
      if (++calls > 1) {
        await new Promise(r => setTimeout(r, 300));
        throw new Error("synthetic renew failure");
      }
      return lockStudy(id, until);
    });
    const lookup = orthanc.backend.lookupStudyIds.bind(orthanc.backend);
    let broken = false;
    vi.spyOn(orthanc.backend, "lookupStudyIds").mockImplementation(async (uid) => {
      if (broken) throw new Error("synthetic lookup failure");
      return lookup(uid);
    });
    const remove = orthanc.backend.deleteStudyInstances.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "deleteStudyInstances").mockImplementation(async (...args) => {
      await remove(...args);
      // 付け直しが始まってから、消した後の引き当てが（付け直しの答えより先に）失敗する
      for (let waited = 0; calls < 2 && waited < 180; waited += 5) await new Promise(r => setTimeout(r, 5));
      broken = true;
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 200, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(calls).toBeGreaterThan(1);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("仕事の終わりを読めなかった後に、途中の付け直しが失敗すれば、結果不明にせず部分反映で止める", async () => {
    temp();
    orthanc.next.state = "Running";
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    let calls = 0;
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementation(async (id, until) => {
      if (++calls > 1) {
        await new Promise(r => setTimeout(r, 300));
        throw new Error("synthetic renew failure");
      }
      return lockStudy(id, until);
    });
    // 付け直しが始まってから、仕事の終わりの読み取りが（付け直しの答えより先に）失敗する
    vi.spyOn(orthanc.backend, "jobStatus").mockImplementation(async () => {
      for (let waited = 0; calls < 2 && waited < 180; waited += 5) await new Promise(r => setTimeout(r, 5));
      throw new BackendUnknownError("synthetic job status failure");
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 200, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(calls).toBeGreaterThan(1);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("印の間に Orthanc の時計が進んでいれば（外す時のずれの確かめが失敗すれば）、消し終えても成功にしない", async () => {
    temp();
    // 付ける時の確かめ（lockStudy の中）は通り、外す時の確かめだけが失敗する
    vi.spyOn(orthanc.backend, "checkLockClock").mockRejectedValue(new Error("synthetic clock jump"));
    expect(await send(a40(TEMP, "P000001"), { lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(orthanc.deleteCalls).toHaveLength(1);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("消した後の読み取りが失敗し、外す時の Orthanc の時計のずれの確かめも失敗すれば、結果不明にせず部分反映で止める", async () => {
    temp();
    vi.spyOn(orthanc.backend, "checkLockClock").mockRejectedValue(new Error("synthetic clock jump"));
    const lookup = orthanc.backend.lookupStudyIds.bind(orthanc.backend);
    let broken = false;
    vi.spyOn(orthanc.backend, "lookupStudyIds").mockImplementation(async (uid) => {
      if (broken) throw new Error("synthetic lookup failure");
      return lookup(uid);
    });
    orthanc.next.duringDelete = () => {
      broken = true;
    };
    expect(await send(a40(TEMP, "P000001"), { lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("付けた後にこの機の時計が巻き戻っても、期限の切れを見逃さない（単調な時計で見る）", async () => {
    temp();
    orthanc.next.duringDelete = () => {
      // 消す間に、この機の時計が 10 分巻き戻り、BFF が 300 ミリ秒止まる（期限 200 ミリ秒）
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() - 600_000, shouldAdvanceTime: true });
      const stalled = performance.now() + 300;
      while (performance.now() < stalled) {
        // 止まった BFF の代わり
      }
    };
    try {
      expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 200, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    } finally {
      vi.useRealTimers();
    }
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("印の切れを見つけた後に確かめが失敗しても、結果不明に戻さず部分反映で止める（自動で解かせない）", async () => {
    temp();
    const lookup = orthanc.backend.lookupStudyIds.bind(orthanc.backend);
    let broken = false;
    vi.spyOn(orthanc.backend, "lookupStudyIds").mockImplementation(async (uid) => {
      if (broken) throw new Error("synthetic lookup failure");
      return lookup(uid);
    });
    orthanc.next.duringDelete = () => {
      const stalled = Date.now() + 300;
      while (Date.now() < stalled) {
        // 止まった BFF の代わり
      }
      // 消した後の引き当て（消し残りと写しの確かめ・画像ごとの確かめ）が、どれも失敗する
      broken = true;
    };
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 200, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
    broken = false;
    expect(await sweep()).toMatchObject({ blocked: "結果の分からない書き換えがある" });
  });

  it("BFF が期限より長く止まった後は、付け直しで隠さず、元を消さずに部分反映で止める", async () => {
    temp();
    orthanc.next.state = "Running";
    const status = orthanc.backend.jobStatus.bind(orthanc.backend);
    let polls = 0;
    vi.spyOn(orthanc.backend, "jobStatus").mockImplementation(async (jobId) => {
      if (++polls === 1) {
        // イベントループを 150 ミリ秒止める（時計の付け直しも動けない）
        const until = Date.now() + 150;
        while (Date.now() < until) { /* 止める */ }
        orthanc.jobs.set(jobId, "Success");
      }
      return status(jobId);
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 60, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(orthanc.deleteCalls).toHaveLength(0);
    expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(1);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("仕事の終わりを読めずに止まったときは印を外さず、仕事が印の期限より後に終わっていれば、照らし合わせで元を消さない", async () => {
    temp();
    orthanc.next.state = "Running";
    expect(await send(a40(TEMP, "P000001"), { jobTimeoutMs: 5 })).toContain("MSA|AE|");
    const source = orthanc.studyId(TEMP, STUDY);
    // 仕事が写している間に外さない
    expect(orthanc.events.filter(e => e.startsWith("unlock:"))).toEqual([]);
    expect(orthanc.locks.has(source)).toBe(true);
    const unknown = results().at(-1)!;
    expect(unknown).toMatchObject({ outcome: "unknown" });
    const lockUntil = Date.parse(String(unknown.detail?.lockUntil));
    expect(lockUntil).toBeGreaterThan(Date.now());
    // 仕事は、印の期限の 1 分後に終わった
    for (const [jobId] of orthanc.jobs) {
      orthanc.jobs.set(jobId, "Success");
      orthanc.jobCompletedAt.set(jobId, new Date(lockUntil + 60_000).toISOString().replace(/\.\d+Z$/, "Z"));
    }
    expect(await sweep()).toMatchObject({ blocked: "結果の分からない書き換えがある" });
    expect(orthanc.deleteCalls).toHaveLength(0);
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("仕事の終わりを読めずに止まっても、仕事が印の期限より前に終わっていれば、照らし合わせで元を消して成功にする", async () => {
    temp();
    orthanc.next.state = "Running";
    expect(await send(a40(TEMP, "P000001"), { jobTimeoutMs: 5 })).toContain("MSA|AE|");
    const unknown = results().at(-1)!;
    const lockUntil = Date.parse(String(unknown.detail?.lockUntil));
    // 仕事は、印の期限の 1 分前に終わった
    for (const [jobId] of orthanc.jobs) {
      orthanc.jobs.set(jobId, "Success");
      orthanc.jobCompletedAt.set(jobId, new Date(lockUntil - 60_000).toISOString().replace(/\.\d+Z$/, "Z"));
    }
    await sweep();
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "success" });
    expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(0);
  });

  it("元の検査を読む間に印を付け直せなければ、書き換えを始めずに AE を返す", async () => {
    temp();
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    let calls = 0;
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementation(async (id, until) => {
      if (++calls > 1) throw new Error("synthetic renew failure");
      return lockStudy(id, until);
    });
    // 元のファイルの印を読むのに 60 ミリ秒かかる：その間に時計の付け直しが呼ばれて失敗する
    const files = orthanc.backend.studyInstanceFiles.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "studyInstanceFiles").mockImplementation(async (id) => {
      await new Promise(r => setTimeout(r, 60));
      return files(id);
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 80, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(calls).toBeGreaterThan(1);
    expect(orthanc.modifyCalls).toHaveLength(0);
    expect(rows.some(r => r.detail?.event === "request")).toBe(false);
  });

  it("Orthanc の時計のずれの許しの分だけ、期限より前に印が切れたとみなす（書き換えを始めない）", async () => {
    temp();
    // 期限 1 秒・許し 2 秒：付けたときから、Orthanc では切れているかもしれない
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 1000, lockClockToleranceMs: 2000, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(orthanc.modifyCalls).toHaveLength(0);
  });

  it.each([
    ["", false],
    ["（続く画像ごとの確かめが失敗しても、部分反映で残す）", true]
  ])("照らし合わせが印を付ける前の引き当てで元を見つけられなくても、印の無いまま元を消さない%s", async (_label, verifyFails) => {
    temp();
    orthanc.next.state = "Running";
    expect(await send(a40(TEMP, "P000001"), { jobTimeoutMs: 5 })).toContain("MSA|AE|");
    for (const [jobId] of orthanc.jobs) {
      orthanc.jobs.set(jobId, "Success");
    }
    // 照らし合わせが仕事の終わりを読んだ直後の引き当て（印を付けるかを決める）だけ、空を返す。verifyFails なら、その後の
    // 3 回目（消すかの確かめの 2 回の後の、画像ごとの確かめ）が失敗する
    const status = orthanc.backend.jobStatus.bind(orthanc.backend);
    const lookup = orthanc.backend.lookupStudyIds.bind(orthanc.backend);
    let after: number | undefined;
    vi.spyOn(orthanc.backend, "jobStatus").mockImplementation(async (jobId) => {
      after = 0;
      return status(jobId);
    });
    vi.spyOn(orthanc.backend, "lookupStudyIds").mockImplementation(async (uid) => {
      if (after === undefined) {
        return lookup(uid);
      }
      const n = after++;
      if (n === 0) {
        return [];
      }
      if (n === 3 && verifyFails) {
        throw new Error("synthetic lookup failure");
      }
      return lookup(uid);
    });
    await sweep();
    expect(orthanc.deleteCalls).toHaveLength(0);
    expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(1);
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("書き換えを求めた答えが来なければ（仕事ができて写しているかもしれない）、印を外さずに結果不明で止める", async () => {
    temp();
    orthanc.next.state = "Running";
    const modify = orthanc.backend.modifyStudyKeepingUids.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "modifyStudyKeepingUids").mockImplementation(async (id, replace) => {
      await modify(id, replace);
      throw new BackendUnknownError();
    });
    expect(await send(a40(TEMP, "P000001"), { lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(orthanc.events.filter(e => e.startsWith("unlock:"))).toEqual([]);
    expect(orthanc.locks.has(orthanc.studyId(TEMP, STUDY))).toBe(true);
    expect(results().at(-1)).toMatchObject({ outcome: "unknown", detail: { lockUntil: expect.any(String) } });
    // 仕事の ID が無いので、照らし合わせは自動で解かない
    expect(await sweep()).toMatchObject({ blocked: "結果の分からない書き換えがある" });
    expect(orthanc.deleteCalls).toHaveLength(0);
  });

  it.each([
    ["仕事を作った時の印の期限より後に終わっていれば", 60_000, "消さない"],
    ["仕事を作った時の印の期限を読めなければ", undefined, "消さない"],
    ["仕事を作った時の印の期限より前に終わっていれば", -60_000, "消す"]
  ] as const)("BFF が仕事を待つ間に止まり結果を残せなかったとき、%s、照らし合わせで元を%s", async (_label, offset, outcome) => {
    const kept = outcome === "消さない";
    temp();
    orthanc.next.state = "Running";
    expect(await send(a40(TEMP, "P000001"), { jobTimeoutMs: 5 })).toContain("MSA|AE|");
    // 結果不明の行を残す前に止まった形にする（dispatch の行の印の期限だけが残る）
    rows = rows.filter(r => r.detail?.event !== "result");
    const dispatch = rows.find(r => r.detail?.event === "dispatch")!;
    const lockUntil = Date.parse(String(dispatch.detail?.lockUntil));
    expect(lockUntil).toBeGreaterThan(0);
    if (offset === undefined) {
      delete dispatch.detail!.lockUntil;
    }
    for (const [jobId] of orthanc.jobs) {
      orthanc.jobs.set(jobId, "Success");
      orthanc.jobCompletedAt.set(jobId, new Date(lockUntil + (offset ?? 60_000)).toISOString().replace(/\.\d+Z$/, "Z"));
    }
    await sweep();
    const reconciled = rows.filter(r => r.detail?.event === "reconcile").at(-1);
    if (kept) {
      expect(reconciled).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
      expect(orthanc.deleteCalls).toHaveLength(0);
    } else {
      expect(reconciled).toMatchObject({ outcome: "success" });
      expect(orthanc.instances.filter(i => i.PatientID === TEMP)).toHaveLength(0);
    }
  });

  it("仕事を待つ間に印を付け直せなければ、元を消さずに部分反映で止め、仕事が写しているかもしれない印は外さない", async () => {
    temp();
    orthanc.next.state = "Running";
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    let calls = 0;
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementation(async (id, until) => {
      if (++calls > 1) throw new Error("synthetic renew failure");
      return lockStudy(id, until);
    });
    const status = orthanc.backend.jobStatus.bind(orthanc.backend);
    let polls = 0;
    vi.spyOn(orthanc.backend, "jobStatus").mockImplementation(async (jobId) => {
      // 付け直しの時計が回るまで仕事を終わらせない
      if (++polls === 1) await new Promise(r => setTimeout(r, 60));
      if (polls === 3) orthanc.jobs.set(jobId, "Success");
      return status(jobId);
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 80, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AE|");
    expect(calls).toBeGreaterThan(1);
    expect(orthanc.deleteCalls).toHaveLength(0);
    expect(orthanc.events.filter(e => e.startsWith("unlock:"))).toEqual([]);
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, lockLost: true } });
  });

  it("仕事を待つ間も、時計で印を付け直す", async () => {
    temp();
    orthanc.next.state = "Running";
    const status = orthanc.backend.jobStatus.bind(orthanc.backend);
    let polls = 0;
    vi.spyOn(orthanc.backend, "jobStatus").mockImplementation(async (jobId) => {
      // 1 回目の読み取りを 120 ミリ秒待たせる（その間は poll の付け直しが無い）
      if (++polls === 1) await new Promise(r => setTimeout(r, 120));
      if (polls === 2) orthanc.jobs.set(jobId, "Success");
      return status(jobId);
    });
    const locks = () => orthanc.events.filter(e => e.startsWith("lock:")).length;
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 80, pollMs: 0, lockSettleMs: 0 })).toContain("MSA|AA|");
    expect(locks()).toBeGreaterThan(2);
  });

  it("照合の後・印の前に同じ UID の画像が別の値で置き換わっていれば、書き換えも記録もせずに AE を返す", async () => {
    const original = temp();
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementationOnce(async (id, until) => {
      // 印が付く直前に、同じ患者 ID・同じ UID で、別の氏名の画像が C-STORE で届く
      expect(orthanc.cstore({ ...original, PatientName: "OTHER^PATIENT" })).toBe("stored");
      return lockStudy(id, until);
    });
    const ack = await send(a40(TEMP, "P000001"));
    expect(ack).toContain("MSA|AE|");
    expect(ack).toContain("書き換えの前に検査の画像が変わった");
    expect(orthanc.modifyCalls).toHaveLength(0);
    expect(rows.some(r => r.detail?.event === "request")).toBe(false);
    expect(orthanc.events.at(-1)).toMatch(/^unlock:/);
  });

  it("外した後に、途中の付け直しが印を付け直さない", async () => {
    temp();
    const lockStudy = orthanc.backend.lockStudy.bind(orthanc.backend);
    let calls = 0;
    vi.spyOn(orthanc.backend, "lockStudy").mockImplementation(async (id, until) => {
      // 2 回目（時計の付け直し）の答えを遅らせる
      if (++calls === 2) await new Promise(r => setTimeout(r, 40));
      return lockStudy(id, until);
    });
    const status = orthanc.backend.jobStatus.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "jobStatus").mockImplementation(async (jobId) => {
      await new Promise(r => setTimeout(r, 30));
      return status(jobId);
    });
    expect(await send(a40(TEMP, "P000001"), { lockTtlMs: 40, pollMs: 0, lockSettleMs: 0 })).toBeTruthy();
    await new Promise(r => setTimeout(r, 80));
    expect(orthanc.events.at(-1)).toMatch(/^unlock:/);
    expect(orthanc.locks.size).toBe(0);
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

  it("書き換えが失敗して元が残り、印を外せなければ、期限まで C-STORE を断る（受ける側に倒れない）", async () => {
    temp();
    orthanc.next.state = "Failure";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(orthanc.backend, "unlockStudy").mockRejectedValue(new Error("synthetic"));
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AE|");
    warn.mockRestore();
    // 送り手には断りが返り、後で送り直す
    expect(orthanc.cstore({ PatientID: TEMP, StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.9.1` })).toBe("refused");
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

  it("確かめてから消すまでの間に写しが置き換わったら、元を消した後でも成功にせず、部分反映で止める", async () => {
    temp();
    orthanc.next.beforeDelete = () => {
      const copy = orthanc.instances.find(i => i.PatientID === "P000001")!;
      orthanc.restStore({ ...copy });
    };
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AE|");
    expect(results().at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, foreignCopies: true, state: "Success" } });
    expect(await sweep()).toMatchObject({ blocked: "結果の分からない書き換えがある" });
  });

  it("照らし合わせでも、確かめてから消すまでの間に写しが置き換わったら、成功にしない", async () => {
    temp();
    orthanc.next.state = "Running";
    expect(await send(a40(TEMP, "P000001"), { jobTimeoutMs: 5 })).toContain("MSA|AE|");
    for (const [jobId] of orthanc.jobs) orthanc.jobs.set(jobId, "Success");
    orthanc.next.beforeDelete = () => {
      const copy = orthanc.instances.find(i => i.PatientID === "P000001")!;
      orthanc.restStore({ ...copy });
    };
    expect(await sweep()).toMatchObject({ blocked: "結果の分からない書き換えがある" });
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, foreignCopies: true } });
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
