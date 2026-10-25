import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntryInput } from "@/lib/audit";
import { enqueue, processMessage } from "@/lib/hl7/apply";
import { REMEMBER_TTL_MS, memory, ordersForChain, resolveAlias, sweepArrivals, withinTtl } from "@/lib/hl7/sweep";
import { createFakeOrthanc, type FakeOrthanc } from "./helpers/fake-orthanc";

// 照合の後に仮の患者 ID で届いた画像の書き換え（IHE PIR の Case 6）と、ORM の CA・DC・XO（design.md §15・§16）。
// 患者の取り違えが起きない形を、画像ごとの小さな Orthanc で確かめる。
const A40 = readFileSync("tests/fixtures/hl7/a40.hl7").toString();
const ORM = readFileSync("tests/fixtures/hl7/orm.hl7").toString();
const A08 = readFileSync("tests/fixtures/hl7/a08.hl7").toString();
const TEMP = "ER2026102400";
const STUDY = "2.25.100";
let seq = 0;
const a40 = (from: string, to: string) =>
  A40.replace("ER2026102400", from).replace("P000001", to).replace("20261024201530A40A", `A40${++seq}`);
const orm = (patient: string, uid: string, accession: string, control = "NW") =>
  ORM.replace("P000001", patient)
    .replace("2.25.67256859653214869994870466343258677753", uid)
    .replaceAll("RE202610210001", accession)
    .replace("ORC|NW", `ORC|${control}`)
    .replace("20261024201532ORMA", `ORM${++seq}`);

let orthanc: FakeOrthanc;
let rows: AuditEntryInput[];
let clock: number;
const audit = async (row: AuditEntryInput) => {
  rows.push(row);
};
const options = () => ({ readHistory: async () => rows, issuer: "RIS_EMU", allowWrite: true, pollMs: 1, now: () => clock });
const send = (text: string) => processMessage(Buffer.from(text), "192.0.2.1", orthanc.backend, audit, options());
const sweep = () => sweepArrivals(orthanc.backend, audit, options());
const temp = (uid = STUDY, extra: Record<string, string> = {}) =>
  orthanc.add({ PatientID: TEMP, PatientName: "UNKNOWN^MALE", PatientSex: "M", StudyInstanceUID: uid, ...extra });
const patientsOf = (uid: string) => [...new Set(orthanc.instances.filter(i => i.StudyInstanceUID === uid).map(i => i.PatientID))];
const quietly = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  orthanc = createFakeOrthanc();
  rows = [];
  seq = 0;
  clock = Date.now();
});

describe("照合の後に仮の患者 ID で届いた画像", () => {
  it("A40 で統合した検査に届いた画像を、統合した先の患者と受付番号に書き換え、1 件にまとめる", async () => {
    temp();
    temp();
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(await send(orm("P000001", STUDY, "RE1"))).toContain("MSA|AA|");
    const late = temp(STUDY, { SeriesInstanceUID: `${STUDY}.2`, SOPInstanceUID: `${STUDY}.2.1` });
    expect(await orthanc.backend.lookupStudyIds(STUDY)).toHaveLength(2);

    expect(await sweep()).toEqual({ count: 1, skipped: 0 });

    expect(await orthanc.backend.lookupStudyIds(STUDY)).toHaveLength(1);
    expect(orthanc.instances).toHaveLength(3);
    expect(orthanc.instances.every(i => i.PatientID === "P000001" && i.AccessionNumber === "RE1")).toBe(true);
    const moved = orthanc.instances.find(i => i.SOPInstanceUID === late.SOPInstanceUID)!;
    expect(moved).toMatchObject({ PatientName: "TANAKA^HIROSHI=田中^博=タナカ^ヒロシ", PatientBirthDate: "19980312", SeriesInstanceUID: late.SeriesInstanceUID });
    const result = rows.filter(r => r.detail?.type === "sweep" && r.detail?.event === "result").at(-1)!;
    expect(result).toMatchObject({ outcome: "success", patientId: "P000001", studyInstanceUid: STUDY });
    expect(result.detail).toMatchObject({ matchesAfter: true, alongside: expect.any(Array) });
    expect(orthanc.modifyCalls.at(-1)).toMatchObject({ replace: { PatientID: "P000001", AccessionNumber: "RE1" } });
    // 元の検査からは、書き換えた画像だけを名指しで消した
    expect(orthanc.deleteCalls.at(-1)).toEqual({ id: orthanc.studyId(TEMP, STUDY), sops: [late.SOPInstanceUID] });
    // もう一度回しても何もしない
    expect(await sweep()).toEqual({ count: 0, skipped: 0 });
  });

  it("A40 の時点で画像が無くても、統合した先の ORM の検査なら書き換える", async () => {
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(await send(orm("P000001", STUDY, "RE1"))).toContain("MSA|AA|");
    temp();
    expect(await sweep()).toMatchObject({ count: 1 });
    expect(orthanc.instances[0]).toMatchObject({ PatientID: "P000001", AccessionNumber: "RE1", PatientName: "TANAKA^HIROSHI=田中^博=タナカ^ヒロシ" });
  });

  it("受け口が止まっていた間に届いた画像も、起き直した後の最初の見回りでまとめて書き換える", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    for (const n of [2, 3, 4]) {
      temp(STUDY, { SeriesInstanceUID: `${STUDY}.${n}`, SOPInstanceUID: `${STUDY}.${n}.1` });
    }
    clock += 6 * 60 * 60 * 1000;
    expect(await sweep()).toMatchObject({ count: 1 });
    expect(patientsOf(STUDY)).toEqual(["P000001"]);
    expect(orthanc.instances).toHaveLength(4);
  });

  it("別の患者の画像と、覚えの無い検査は書き換えない", async () => {
    const warn = quietly();
    temp();
    orthanc.add({ PatientID: "Q000009", PatientName: "OTHER^ONE", StudyInstanceUID: "2.25.900" });
    await send(a40(TEMP, "P000001"));
    // 同じ仮の患者 ID を使い回した、別の緊急の撮影（Study が違う）
    temp("2.25.777");
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    expect(patientsOf("2.25.777")).toEqual([TEMP]);
    expect(patientsOf("2.25.900")).toEqual(["Q000009"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("A40 を別の MSH-10 で送り直しても、最初の A40 の検査と ORM を使う", async () => {
    temp();
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(await send(orm("P000001", STUDY, "RE1"))).toContain("MSA|AA|");
    // 送り直しの時点では仮の患者の検査が無い（覚えの studies は空）
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    expect(await sweep()).toMatchObject({ count: 1 });
    expect(orthanc.instances.every(i => i.PatientID === "P000001" && i.AccessionNumber === "RE1")).toBe(true);
  });

  it("統合の前と生年月日・性別が食い違う画像は書き換えない（空は比べない）", async () => {
    const warn = quietly();
    temp(STUDY, { PatientBirthDate: "19800101" });
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { PatientBirthDate: "20000101", SOPInstanceUID: `${STUDY}.2.1` });
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    orthanc.instances = orthanc.instances.filter(i => i.SOPInstanceUID !== `${STUDY}.2.1`);
    temp(STUDY, { PatientSex: "F", SOPInstanceUID: `${STUDY}.3.1` });
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    orthanc.instances = orthanc.instances.filter(i => i.SOPInstanceUID !== `${STUDY}.3.1`);
    temp(STUDY, { PatientSex: "", SOPInstanceUID: `${STUDY}.4.1` });
    expect(await sweep()).toMatchObject({ count: 1 });
    warn.mockRestore();
  });

  it("統合した先の検査にある画像の送り直しは書き換えず、後の書き換えを止めない", async () => {
    const warn = quietly();
    const original = temp();
    await send(a40(TEMP, "P000001"));
    // モダリティが同じ画像を仮の患者 ID のまま送り直す
    temp(STUDY, { SeriesInstanceUID: original.SeriesInstanceUID, SOPInstanceUID: original.SOPInstanceUID });
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    expect(orthanc.modifyCalls.filter(c => c.replace.PatientID === "P000001")).toHaveLength(1);
    expect(await send(a40("ER9", "P000009"))).toContain("MSA|AA|");
    warn.mockRestore();
  });

  it("統合された後の中間の患者 ID の ORM は使わない（別の患者のものでありうる）", async () => {
    const warn = quietly();
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(await send(a40("P000001", "P000002"))).toContain("MSA|AA|");
    clock += 1000;
    vi.useFakeTimers({ now: clock, toFake: ["Date"] });
    try {
      expect(await send(orm("P000001", STUDY, "OTHER-ORDER"))).toContain("MSA|AA|");
    } finally {
      vi.useRealTimers();
    }
    temp();
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    expect(patientsOf(STUDY)).toEqual([TEMP]);
    warn.mockRestore();
  });

  it("期限で最初の A40 が古くなっても、送り直しを新しい段として使わない", () => {
    const day = REMEMBER_TTL_MS;
    const now = Date.parse("2026-10-26T12:00:00Z");
    const ack = (remember: Record<string, unknown>, ago: number): AuditEntryInput => ({
      actorId: "hl7-receiver", actorRole: "system", authMode: "hl7", action: "hl7", outcome: "success",
      detail: { event: "ack", code: "AA", remember: { ...remember, at: new Date(now - ago).toISOString() } }
    });
    const a = (from: string, to: string) => ({ kind: "alias", from, to, studies: [], fromNames: [], attributes: {} });
    const { aliases, orders } = memory([
      ack(a("T", "P1"), day + 60_000),
      ack(a("P1", "P2"), day + 30_000),
      ack(a("T", "P1"), 60_000),
      ack({ kind: "order", patientId: "P1", uid: "2.25.5", accession: "OTHER", control: "NW" }, 30_000)
    ]);
    const links = resolveAlias(aliases, "T")!;
    // 送り直しは最初の段にまとまり、統合の先は P2 のまま。最初の段は期限の外なので使わない
    expect(links.map(l => l.to)).toEqual(["P1", "P2"]);
    expect(withinTtl(links[0]!, now)).toBe(false);
    // 統合された後の P1 の ORM は使わない
    expect(ordersForChain(links, orders)).toEqual([]);
  });

  it("時計が 5 分より大きく戻ったら、時計が追いつくまで書き換えない", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    expect(await send(orm("P000001", STUDY, "RE1"))).toContain("MSA|AA|");
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    // 受理の時刻（いまの時計）より 10 分前に時計が戻った
    clock -= 10 * 60 * 1000;
    expect(await sweep()).toMatchObject({ count: 0, blocked: expect.stringContaining("時計が戻った") });
    expect(patientsOf(STUDY).sort()).toEqual(["P000001", TEMP].sort());
    clock += 20 * 60 * 1000;
    expect(await sweep()).toMatchObject({ count: 1 });
  });

  it.each([
    ["ORM", { kind: "order", patientId: "P000001", uid: STUDY, accession: "RE9", control: "NW" }],
    ["続きの A40", { kind: "alias", from: "P000001", to: "P000002", studies: [], fromNames: [], attributes: {} }]
  ])("最初の A40 は期限の中でも、%s だけが時計より 5 分より先なら書き換えない", async (_name, remember) => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    rows.push({
      actorId: "hl7-receiver", actorRole: "system", authMode: "hl7", action: "hl7", outcome: "success",
      detail: { event: "ack", code: "AA", remember: { ...remember, at: new Date(clock + 10 * 60 * 1000).toISOString() } }
    });
    const calls = orthanc.modifyCalls.length;
    expect(await sweep()).toMatchObject({ count: 0, blocked: expect.stringContaining("時計が戻った") });
    expect(orthanc.modifyCalls).toHaveLength(calls);
    // 時計が追いつけば見回りは止まらない（続きの A40 の場合は、統合の先が P000002 になり、同じ UID の検査が
    // P000001 にあるので書き換えずに残す）
    clock += 11 * 60 * 1000;
    const after = await sweep();
    expect(after.blocked).toBeUndefined();
    expect(after.count).toBe(remember.kind === "order" ? 1 : 0);
  });

  it("同じ時刻に受理した ORM と次の A40 は、受理した順で前後を決める", () => {
    const at = "2026-10-26T12:00:00.000Z";
    const ack = (remember: Record<string, unknown>): AuditEntryInput => ({
      actorId: "hl7-receiver", actorRole: "system", authMode: "hl7", action: "hl7", outcome: "success",
      detail: { event: "ack", code: "AA", remember: { ...remember, at } }
    });
    const a = (from: string, to: string) => ({ kind: "alias", from, to, studies: [], fromNames: [], attributes: {} });
    const o = (uid: string) => ({ kind: "order", patientId: "P1", uid, accession: uid, control: "NW" });
    const { aliases, orders } = memory([ack(a("T", "P1")), ack(o("2.25.1")), ack(a("P1", "P2")), ack(o("2.25.2"))]);
    const links = resolveAlias(aliases, "T")!;
    expect(ordersForChain(links, orders).map(x => x.uid)).toEqual(["2.25.1"]);
  });

  it("同じ StudyInstanceUID の検査が別の患者にあれば書き換えない", async () => {
    const warn = quietly();
    temp();
    await send(a40(TEMP, "P000001"));
    orthanc.add({ PatientID: "Q000009", StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.9.1` });
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    expect(patientsOf(STUDY).sort()).toEqual(["P000001", "Q000009", TEMP].sort());
    warn.mockRestore();
  });

  it("統合の前と氏名が違う画像は書き換えない", async () => {
    const warn = quietly();
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { PatientName: "SOMEONE^ELSE", SOPInstanceUID: `${STUDY}.2.1` });
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    warn.mockRestore();
  });

  it("期限（24 時間）の外の A40 は使わない", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    clock += REMEMBER_TTL_MS + 1000;
    expect(await sweep()).toEqual({ count: 0, skipped: 0 });
    expect(patientsOf(STUDY).sort()).toEqual(["P000001", TEMP].sort());
  });

  it("統合が 2 段（仮→正→別の正）なら、いまの患者に書き換える", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    expect(await send(a40("P000001", "P000002"))).toContain("MSA|AA|");
    expect(patientsOf(STUDY)).toEqual(["P000002"]);
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    expect(await sweep()).toMatchObject({ count: 1 });
    expect(patientsOf(STUDY)).toEqual(["P000002"]);
  });

  it("同じ仮の患者 ID から 2 つの先がある・輪になっているときは書き換えない", async () => {
    const at = new Date().toISOString();
    let n = 0;
    const alias = (from: string, to: string) => ({ kind: "alias" as const, from, to, studies: [STUDY], fromNames: [], attributes: {}, at, seq: n++, time: Date.parse(at) });
    expect(resolveAlias([alias("T", "P1"), alias("T", "P3")], "T")).toBeNull();
    expect(resolveAlias([alias("T", "P1"), alias("P1", "T")], "T")).toBeNull();
    expect(resolveAlias([alias("T", "P1"), alias("P1", "P2")], "T")?.map(l => l.to)).toEqual(["P1", "P2"]);

    const warn = quietly();
    temp();
    await send(a40(TEMP, "P000001"));
    await send(a40(TEMP, "P000003"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    expect(await sweep()).toMatchObject({ count: 0, skipped: 1 });
    expect(patientsOf(STUDY).sort()).toEqual(["P000001", TEMP].sort());
    warn.mockRestore();
  });

  it("届き終えていない検査は待ち、届き終えた後の見回りで書き換える", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    orthanc.unstable.add(orthanc.studyId(TEMP, STUDY));
    expect(await sweep()).toEqual({ count: 0, skipped: 0 });
    orthanc.unstable.clear();
    expect(await sweep()).toMatchObject({ count: 1 });
  });

  it("書き換えの最中に届いた画像があれば、部分反映として止め、届いた画像は書き換えない", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    orthanc.next.beforeModify = () => void temp(STUDY, { SOPInstanceUID: `${STUDY}.3.1` });
    // 書き換えた後の確かめで画像の数が合わないので、取り違えて書くより止める（人が /api/hl7/resolve で解く）
    expect(await sweep()).toMatchObject({ count: 0, blocked: "画像の一部だけが書き換わった" });
    expect(orthanc.instances.filter(i => i.PatientID === TEMP).map(i => i.SOPInstanceUID)).toEqual([`${STUDY}.3.1`]);
    expect(rows.filter(r => r.detail?.type === "sweep" && r.detail?.event === "result").at(-1)?.detail).toMatchObject({ partial: true });
    expect(await sweep()).toMatchObject({ count: 0, blocked: "結果の分からない書き換えがある" });
  });

  it("最中に届いた画像を検査ごと消す Orthanc なら、届いた画像が消えたことを見つけて部分反映で止める", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    orthanc.next.beforeModify = () => void temp(STUDY, { SOPInstanceUID: `${STUDY}.3.1` });
    orthanc.next.wholeStudyDelete = true;
    expect(await sweep()).toMatchObject({ count: 0, blocked: "画像の一部だけが書き換わった" });
    expect(orthanc.instances.some(i => i.SOPInstanceUID === `${STUDY}.3.1`)).toBe(false);
    const result = rows.filter(r => r.detail?.type === "sweep" && r.detail?.event === "result").at(-1)!;
    expect(result).toMatchObject({ outcome: "failed", detail: { partial: true, arrivalsLost: true } });
    // 書き換えを頼んだのは名指しの画像だけ
    expect(orthanc.deleteCalls.at(-1)?.sops).toEqual([`${STUDY}.2.1`]);
  });

  it("仕事の終わりを待ちきれずに止まっても、仕事が成功していれば、次の照らし合わせで元の画像を消して解く", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    // 画像は書き換わったが、仕事の状態は Running のまま待ちきれない
    orthanc.next.state = "Running";
    const deletes = orthanc.deleteCalls.length;
    const result = await sweepArrivals(orthanc.backend, audit, { ...options(), jobTimeoutMs: 0 });
    expect(result).toMatchObject({ count: 0, blocked: "書き換えに失敗した" });
    expect(rows.filter(r => r.detail?.event === "result").at(-1)).toMatchObject({ outcome: "unknown", detail: { reason: "仕事の完了を待つ時間を超えた" } });
    expect(orthanc.deleteCalls).toHaveLength(deletes);
    for (const id of orthanc.jobs.keys()) orthanc.jobs.set(id, "Success");
    // 次の見回りの照らし合わせが、確かめてから元の画像を名指しで消し、成功として解く
    expect(await sweep()).toEqual({ count: 0, skipped: 0 });
    expect(orthanc.deleteCalls.at(-1)).toEqual({ id: orthanc.studyId(TEMP, STUDY), sops: [`${STUDY}.2.1`] });
    expect(patientsOf(STUDY)).toEqual(["P000001"]);
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "success", detail: { partial: false, matchesAfter: true } });
  });

  it("書き換えの後に同じ UID の画像が元の検査へ届き直して置き換わったら、その画像を消さずに部分反映で止める", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    const late = temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    let resent: typeof late | undefined;
    // 仕事が写した後、元を消す前に、モダリティが同じ UID の画像を送り直す（OverwriteInstances で置き換わる）
    orthanc.next.beforeDelete = () => {
      orthanc.instances = orthanc.instances.filter(i => i !== late);
      resent = temp(STUDY, { SOPInstanceUID: late.SOPInstanceUID });
    };
    expect(await sweep()).toMatchObject({ count: 0, blocked: "画像の一部だけが書き換わった" });
    expect(orthanc.instances.includes(resent!)).toBe(true);
    expect(rows.filter(r => r.detail?.type === "sweep" && r.detail?.event === "result").at(-1)).toMatchObject({ detail: { partial: true } });
  });

  it("印を見た後、消す直前の確かめの前に同じ UID の画像が届き直したら、変更の記録で見つけて消さずに部分反映で止める", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    const late = temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    let resent: typeof late | undefined;
    orthanc.next.duringDelete = () => {
      orthanc.instances = orthanc.instances.filter(i => i !== late);
      resent = temp(STUDY, { SOPInstanceUID: late.SOPInstanceUID });
    };
    expect(await sweep()).toMatchObject({ count: 0, blocked: "画像の一部だけが書き換わった" });
    expect(orthanc.instances.includes(resent!)).toBe(true);
    expect(rows.filter(r => r.detail?.type === "sweep" && r.detail?.event === "result").at(-1))
      .toMatchObject({ outcome: "failed", detail: { partial: true } });
  });

  it("消す直前の確かめで変更の記録を読めずに止まっても、次の照らし合わせは届き直した画像を消さず、成功にしない", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    const late = temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    let resent: typeof late | undefined;
    orthanc.next.duringDelete = () => {
      orthanc.instances = orthanc.instances.filter(i => i !== late);
      resent = temp(STUDY, { SOPInstanceUID: late.SOPInstanceUID });
    };
    orthanc.next.changesFail = true;
    expect(await sweep()).toMatchObject({ count: 0, blocked: "書き換えに失敗した" });
    expect(rows.filter(r => r.detail?.event === "result").at(-1)).toMatchObject({ outcome: "unknown" });
    expect(await sweep()).toMatchObject({ count: 0, blocked: "結果の分からない書き換えがある" });
    expect(orthanc.instances.includes(resent!)).toBe(true);
    expect(rows.filter(r => r.detail?.event === "reconcile").at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true } });
  });

  it("書き換えた画像が替え先の検査に揃わなければ、元の画像を消さずに部分反映で止める", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.2` });
    orthanc.next.partial = true;
    const calls = orthanc.deleteCalls.length;
    expect(await sweep()).toMatchObject({ count: 0, blocked: "画像の一部だけが書き換わった" });
    expect(orthanc.deleteCalls).toHaveLength(calls);
    expect(orthanc.instances.filter(i => i.PatientID === TEMP).map(i => i.SOPInstanceUID).sort()).toEqual([`${STUDY}.2.1`, `${STUDY}.2.2`]);
  });

  it("誤った A40 の後に人が元の患者へ書き戻しても、見回りは統合し直さない", async () => {
    const warn = quietly();
    temp();
    temp(STUDY, { SOPInstanceUID: `${STUDY}.1.9` });
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    expect(patientsOf(STUDY)).toEqual(["P000001"]);
    // 人が Orthanc で、UID を保ったまま元の患者 ID と氏名へ書き戻す
    orthanc.instances = orthanc.instances.map(i => ({ ...i, PatientID: TEMP, PatientName: "UNKNOWN^MALE", PatientBirthDate: "", PatientSex: "M" }));
    const calls = orthanc.modifyCalls.length;
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    expect(orthanc.modifyCalls).toHaveLength(calls);
    expect(patientsOf(STUDY)).toEqual([TEMP]);
    warn.mockRestore();
  });

  it("同じ UID の検査が仮の患者 2 人と統合した先の患者の 3 件にあれば、どれも書き換えない", async () => {
    const warn = quietly();
    temp();
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    // もう 1 人の仮の患者も、画像が届く前に同じ先へ統合した
    expect(await send(a40("ER2026102401", "P000001"))).toContain("MSA|AA|");
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    orthanc.add({ PatientID: "ER2026102401", PatientName: "UNKNOWN^MALE", PatientSex: "M", StudyInstanceUID: STUDY, SOPInstanceUID: `${STUDY}.3.1` });
    const calls = orthanc.modifyCalls.length;
    expect(await sweep()).toMatchObject({ count: 0 });
    expect(orthanc.modifyCalls).toHaveLength(calls);
    expect(patientsOf(STUDY).sort()).toEqual(["ER2026102401", "P000001", TEMP].sort());
    warn.mockRestore();
  });

  it("読んだ画像の患者 ID が仮の患者 ID と違えば書き換えない", async () => {
    const warn = quietly();
    temp();
    await send(a40(TEMP, "P000001"));
    const late = temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    // Orthanc の検査の要約は仮の患者 ID だが、画像の 1 枚は別の患者 ID
    const read = orthanc.backend.studyInstanceTags.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "studyInstanceTags").mockImplementation(async (id) =>
      (await read(id)).map(i => i.SOPInstanceUID === late.SOPInstanceUID ? { ...i, PatientID: "Q000009" } : i));
    const calls = orthanc.modifyCalls.length;
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    expect(orthanc.modifyCalls).toHaveLength(calls);
    warn.mockRestore();
  });

  it.each([
    ["A40", () => a40(TEMP, "P000001")],
    ["A08", () => A08.replace("P000001", TEMP).replace("20261024201531A08A", `A08${++seq}`)]
  ])("%s でも、読んだ画像の患者 ID がメッセージの患者 ID と違えば、書き換えずに AE", async (_name, message) => {
    temp();
    // Orthanc の検査の要約は仮の患者 ID だが、画像は全部、別の患者 ID
    const read = orthanc.backend.studyInstanceTags.bind(orthanc.backend);
    vi.spyOn(orthanc.backend, "studyInstanceTags").mockImplementation(async (id) => (await read(id)).map(i => ({ ...i, PatientID: "Q000009" })));
    expect(await send(message())).toContain("MSA|AE|");
    expect(orthanc.modifyCalls).toEqual([]);
    expect(orthanc.deleteCalls).toEqual([]);
  });

  it("統合した先の患者の ORM でも、最初の A40 より前に受理したものは使わない", async () => {
    const warn = quietly();
    // 統合の前の P000001 の予約（仮の患者の検査とは限らない）
    expect(await send(orm("P000001", STUDY, "RE0"))).toContain("MSA|AA|");
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    temp();
    expect(await sweep()).toEqual({ count: 0, skipped: 1 });
    expect(patientsOf(STUDY)).toEqual([TEMP]);
    warn.mockRestore();
  });

  it("メッセージと見回りが同時に来ても、1 つずつ順に処理する", async () => {
    temp();
    const order: string[] = [];
    const first = enqueue(async () => {
      order.push("A40 開始");
      const ack = await send(a40(TEMP, "P000001"));
      order.push("A40 終了");
      return ack;
    });
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    const second = enqueue(async () => {
      order.push("見回り開始");
      const result = await sweep();
      order.push("見回り終了");
      return result;
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["A40 開始", "A40 終了", "見回り開始", "見回り終了"]);
    expect(patientsOf(STUDY)).toEqual(["P000001"]);
  });

  it("結果の分からない書き換えがあれば、見回りは何も書き換えない", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.2` });
    orthanc.next.partial = true;
    expect(await sweep()).toMatchObject({ count: 0, blocked: "画像の一部だけが書き換わった" });
    const calls = orthanc.modifyCalls.length;
    expect(await sweep()).toMatchObject({ count: 0, blocked: "結果の分からない書き換えがある" });
    // 次の A40 も止まる（メッセージと見回りは同じ照らし合わせを使う）
    expect(await send(a40("ER9", "P000009"))).toContain("MSA|AE|");
    expect(orthanc.modifyCalls).toHaveLength(calls);
  });

  it("検証モードで書き込みを許していなければ、見回りは何もしない", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    const result = await sweepArrivals(orthanc.backend, audit, { ...options(), allowWrite: false });
    expect(result).toMatchObject({ count: 0, blocked: expect.any(String) });
    expect(patientsOf(STUDY).sort()).toEqual(["P000001", TEMP].sort());
  });

  it("AE を返した A40 は覚えない", async () => {
    temp();
    orthanc.next.state = "Failure";
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AE|");
    expect(rows.some(r => r.detail?.remember)).toBe(false);
  });
});

describe("ORM の CA・DC・XO", () => {
  const study = () => orthanc.add({ PatientID: "P000001", PatientName: "TANAKA^HIROSHI", StudyInstanceUID: STUDY, AccessionNumber: "RE1" });

  it.each(["CA", "DC"])("%s は検査と画像を消さずに受付番号を外す", async (control) => {
    study();
    expect(await send(orm("P000001", STUDY, "RE1", control))).toContain("MSA|AA|");
    expect(orthanc.instances).toHaveLength(1);
    expect(orthanc.instances[0]).toMatchObject({ PatientID: "P000001", AccessionNumber: "", StudyInstanceUID: STUDY });
    expect(orthanc.modifyCalls.at(-1)).toMatchObject({ replace: { AccessionNumber: "" } });
    // 患者 ID の変わらない書き換えは、元の画像を消さない（上書きで置き換わる）
    expect(orthanc.deleteCalls).toEqual([]);
    // 送り直し（別の MSH-10）でも、空なら書き換えない
    expect(await send(orm("P000001", STUDY, "RE1", control))).toContain("MSA|AA|");
    expect(orthanc.modifyCalls).toHaveLength(1);
  });

  it("CA の受付番号が検査と違えば AE で、書き換えない", async () => {
    study();
    expect(await send(orm("P000001", STUDY, "RE9", "CA"))).toContain("MSA|AE|");
    expect(orthanc.instances[0]!.AccessionNumber).toBe("RE1");
    expect(orthanc.modifyCalls).toHaveLength(0);
  });

  it("CA の患者 ID が検査と違えば AE で、書き換えない", async () => {
    study();
    expect(await send(orm("P000002", STUDY, "RE1", "CA"))).toContain("MSA|AE|");
    expect(orthanc.modifyCalls).toHaveLength(0);
  });

  it("XO は NW と同じく、空の受付番号を入れる", async () => {
    orthanc.add({ PatientID: "P000001", StudyInstanceUID: STUDY });
    expect(await send(orm("P000001", STUDY, "RE1", "XO"))).toContain("MSA|AA|");
    expect(orthanc.instances[0]!.AccessionNumber).toBe("RE1");
  });

  it("CA の後に仮の患者 ID で届いた画像には、受付番号を入れない", async () => {
    temp();
    await send(a40(TEMP, "P000001"));
    await send(orm("P000001", STUDY, "RE1"));
    expect(orthanc.instances[0]!.AccessionNumber).toBe("RE1");
    await send(orm("P000001", STUDY, "RE1", "CA"));
    temp(STUDY, { SOPInstanceUID: `${STUDY}.2.1` });
    expect(await sweep()).toMatchObject({ count: 1 });
    expect(orthanc.instances.every(i => i.PatientID === "P000001" && i.AccessionNumber === "")).toBe(true);
  });
});
