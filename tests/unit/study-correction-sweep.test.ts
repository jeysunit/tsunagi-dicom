import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuditEntryInput } from "@/lib/audit";
import type { AuditRow, HistoryRow } from "@/lib/keep-uid-write";
import { sweepArrivals } from "@/lib/hl7/sweep";
import { applyAttributeCorrection, readSnapshot } from "@/lib/study-correction";
import { createFakeOrthanc, type FakeOrthanc } from "./helpers/fake-orthanc";

// 画面の患者 ID の付け替え（属性の訂正。openspec/changes/add-study-value-correction/design.md の 2）と、HL7 の見回り
// （照合の後に届いた画像の書き換え）の組み合わせを、画像ごとの小さな Orthanc で確かめる。付け替えの覚えは、付け替えた検査
// だけを統合する（付け替え先の患者の予約の検査には広げない）。人が書き戻した付け替えを、見回りは統合し直さない。

const S = "2.25.300";
const T = "2.25.301";
let orthanc: FakeOrthanc;
let rows: HistoryRow[];
const audit = async (row: AuditEntryInput) => {
  rows.push(row);
};
const options = { readHistory: async () => rows, allowWrite: true, pollMs: 1, lockSettleMs: 0 };
const sweep = () => sweepArrivals(orthanc.backend, audit, options);
const quietly = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

/** 画面の付け替えを、道（src/app/api/studies/[uid]/modify）と同じ行の形で流す */
async function reassign(uid: string, to: string) {
  const requestId = crypto.randomUUID();
  const snap = await readSnapshot(orthanc.backend, uid, "attribute", { PatientID: to });
  // 「求めた」の行の監査の番号（道は、覚えに requestSeq として添える）
  const requestSeq = rows.length;
  rows.push({ actorId: "dev", actorRole: "general", authMode: "dev", action: "modify", outcome: "success", studyInstanceUid: uid, detail: { requestId, phase: "request", kind: "attribute", scope: snap.scope } });
  const row: AuditRow = async (event, outcome, detail = {}, patientId, studyInstanceUid) => {
    rows.push({ actorId: "dev", actorRole: "general", authMode: "dev", action: "modify", outcome, patientId, studyInstanceUid, detail: { requestId, event, ...detail } });
  };
  const out = await applyAttributeCorrection(orthanc.backend, snap, requestId, row, options);
  rows.push({
    actorId: "dev",
    actorRole: "general",
    authMode: "dev",
    action: "modify",
    outcome: out.outcome,
    studyInstanceUid: uid,
    detail: { requestId, phase: "result", kind: "attribute", ...(out.remember ? { remember: { ...out.remember, requestSeq } } : {}) },
  });
  return out;
}
const patientsOf = (uid: string) => [...new Set(orthanc.instances.filter((i) => i.StudyInstanceUID === uid).map((i) => i.PatientID))];

beforeEach(() => {
  orthanc = createFakeOrthanc();
  rows = [];
  orthanc.add({ PatientID: "P1", PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: S });
  orthanc.add({ PatientID: "P1", PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: S });
  orthanc.add({ PatientID: "P1", PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: T });
});

describe("画面の付け替えと HL7 の見回り", () => {
  it("付け替えた検査だけが移り、元の患者のほかの検査は残る。付け替えの後に元の患者ID で届いた画像を、付け替え先へまとめる", async () => {
    const out = await reassign(S, "P2");
    expect(out).toMatchObject({ outcome: "success", count: 1, total: 1 });
    expect(out.remember).toMatchObject({ kind: "alias", origin: "screen", from: "P1", to: "P2", studies: [S] });
    expect(patientsOf(S)).toEqual(["P2"]);
    expect(patientsOf(T)).toEqual(["P1"]);
    // 装置が、付け替えの前の患者 ID のまま、同じ検査の続きの画像を送った
    expect(orthanc.cstore({ PatientID: "P1", PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: S, SeriesInstanceUID: `${S}.9`, SOPInstanceUID: `${S}.9.1` })).toBe("stored");
    expect(await orthanc.backend.lookupStudyIds(S)).toHaveLength(2);
    // 元の患者のほかの検査 T は、付け替えた検査でないので相手にしない
    expect(await sweep()).toEqual({ count: 1, skipped: 0 });
    expect(patientsOf(S)).toEqual(["P2"]);
    expect(await orthanc.backend.lookupStudyIds(S)).toHaveLength(1);
    expect(patientsOf(T)).toEqual(["P1"]);
  });

  it("付け替え先の患者の予約（ORM）の検査には広げない", async () => {
    const warn = quietly();
    await reassign(S, "P2");
    // 付け替えの後に、付け替え先の患者 P2 の予約として T が知らされた（元の患者 P1 の検査 T は、P1 のまま）
    rows.push({
      actorId: "hl7-receiver",
      actorRole: "system",
      authMode: "hl7",
      action: "hl7",
      outcome: "success",
      detail: { event: "ack", code: "AA", remember: { kind: "order", patientId: "P2", uid: T, accession: "RE9", control: "NW", at: new Date().toISOString() } },
    });
    expect(await sweep()).toMatchObject({ count: 0 });
    expect(patientsOf(T)).toEqual(["P1"]);
    warn.mockRestore();
  });

  it("人が画面で付け替えを書き戻したら、見回りは統合し直さない", async () => {
    const warn = quietly();
    await reassign(S, "P2");
    expect(patientsOf(S)).toEqual(["P2"]);
    await reassign(S, "P1");
    expect(patientsOf(S)).toEqual(["P1"]);
    const calls = orthanc.modifyCalls.length;
    expect(await sweep()).toMatchObject({ count: 0 });
    expect(orthanc.modifyCalls).toHaveLength(calls);
    expect(patientsOf(S)).toEqual(["P1"]);
    warn.mockRestore();
  });

  it("付け替えを2回続けた後（覚えの記録の順が逆でも）、最初の患者ID で届いた画像を、検査がいまある患者へまとめる", async () => {
    await reassign(S, "P2");
    await reassign(S, "P3");
    expect(patientsOf(S)).toEqual(["P3"]);
    // 最初の付け替えの覚えが、後の付け替えより後に記録された形（要求全体の結果を後から照会で決めたとき）。時刻は求めた順
    const results = rows.filter((r) => r.detail?.remember);
    (results[0]!.detail!.remember as { at: string }).at = new Date(Date.now() - 2000).toISOString();
    rows = [...rows.filter((r) => !r.detail?.remember), results[1]!, results[0]!];
    expect(orthanc.cstore({ PatientID: "P1", PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: S, SeriesInstanceUID: `${S}.9`, SOPInstanceUID: `${S}.9.1` })).toBe("stored");
    expect(await sweep()).toEqual({ count: 1, skipped: 0 });
    expect(patientsOf(S)).toEqual(["P3"]);
  });

  it("付け替えを2回続けた後に、前の2つの患者ID で画像が届いても、いまの付け替え先へまとめる。付け替え先の検査が消されていればまとめない", async () => {
    await reassign(S, "P2");
    (rows.filter((r) => r.detail?.remember).at(-1)!.detail!.remember as { at: string }).at = new Date(Date.now() - 2000).toISOString();
    await reassign(S, "P3");
    expect(patientsOf(S)).toEqual(["P3"]);
    const late = (patient: string, n: number) =>
      orthanc.cstore({ PatientID: patient, PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: S, SeriesInstanceUID: `${S}.${n}`, SOPInstanceUID: `${S}.${n}.1` });
    expect(late("P1", 8)).toBe("stored");
    expect(late("P2", 9)).toBe("stored");
    // ほかの旧い患者 ID（P2）の検査を先と取り違えず、P1 と P2 の両方を P3 へまとめる
    expect(await sweep()).toEqual({ count: 2, skipped: 0 });
    expect(patientsOf(S)).toEqual(["P3"]);

    // 付け替え先の検査が消された後に、旧い患者 ID で届いても、ほかの旧い患者 ID の検査へはまとめない
    const warn = quietly();
    orthanc.instances = orthanc.instances.filter((i) => i.StudyInstanceUID !== S);
    expect(late("P1", 10)).toBe("stored");
    expect(late("P2", 11)).toBe("stored");
    expect((await sweep()).count).toBe(0);
    expect(patientsOf(S).sort()).toEqual(["P1", "P2"]);
    warn.mockRestore();
  });

  it("時計が戻った後の付け替えでも、求めた順で最後の付け替えを決める（付け替え先が消されていれば、前の患者ID へはまとめない）", async () => {
    await reassign(S, "P2");
    await reassign(S, "P3");
    // 2回目の付け替えの受理の時刻が、1回目より前（時計が戻った）
    const results = rows.filter((r) => r.detail?.remember);
    (results[1]!.detail!.remember as { at: string }).at = new Date(Date.now() - 60_000).toISOString();
    orthanc.instances = orthanc.instances.filter((i) => i.StudyInstanceUID !== S);
    const late = (patient: string, n: number) =>
      orthanc.cstore({ PatientID: patient, PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: S, SeriesInstanceUID: `${S}.${n}`, SOPInstanceUID: `${S}.${n}.1` });
    expect(late("P1", 12)).toBe("stored");
    expect(late("P2", 13)).toBe("stored");
    const warn = quietly();
    expect((await sweep()).count).toBe(0);
    warn.mockRestore();
    expect(patientsOf(S).sort()).toEqual(["P1", "P2"]);
  });

  it("期限は検査ごと：古い検査の付け替えの期限が切れていても、同じ患者どうしの新しい検査の付け替えの画像はまとめる", async () => {
    await reassign(S, "P2");
    await reassign(T, "P2");
    // S の付け替えは 25 時間前とする
    for (const r of rows) {
      const m = r.detail?.remember as { studies?: string[]; at?: string } | undefined;
      if (m?.studies?.includes(S)) m.at = new Date(Date.now() - 25 * 3600_000).toISOString();
    }
    expect(orthanc.cstore({ PatientID: "P1", PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: S, SeriesInstanceUID: `${S}.9`, SOPInstanceUID: `${S}.9.1` })).toBe("stored");
    expect(orthanc.cstore({ PatientID: "P1", PatientName: "SHIKEN^ICHIRO", PatientSex: "M", StudyInstanceUID: T, SeriesInstanceUID: `${T}.9`, SOPInstanceUID: `${T}.9.1` })).toBe("stored");
    expect(await sweep()).toEqual({ count: 1, skipped: 0 });
    expect(patientsOf(T)).toEqual(["P2"]);
    expect(patientsOf(S).sort()).toEqual(["P1", "P2"]);
  });

  it("付け替え先の患者がいれば、その患者の値にそろえる（入力が無ければ、その値をそのまま使う）", async () => {
    orthanc.add({ PatientID: "P3", PatientName: "SHIKEN^SABURO", PatientSex: "M", PatientBirthDate: "19700101", StudyInstanceUID: "2.25.302" });
    const out = await reassign(S, "P3");
    expect(out.outcome).toBe("success");
    expect(orthanc.instances.filter((i) => i.StudyInstanceUID === S).every((i) => i.PatientName === "SHIKEN^SABURO" && i.PatientBirthDate === "19700101")).toBe(true);
  });
});
