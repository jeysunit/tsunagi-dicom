import { execFileSync } from "node:child_process";
import { readFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { computeAuditHash } from "@/lib/audit";
import { createDb, type Db } from "@/lib/db";
import { history, HistoryTampered, processMessage } from "@/lib/hl7/apply";
import { sweepArrivals } from "@/lib/hl7/sweep";
import { createFakeOrthanc, type FakeOrthanc } from "./helpers/fake-orthanc";

// HL7 の経過（監査の記録の HL7 の行）を、使う前に鍵つきの値と前の行とのつなぎで確かめる（design.md §15.3）。
// 覚え（ack の remember）は見回りが画像の患者 ID を書き換える根拠なので、鍵を持たない者が書き足した・書き換えた行を
// 使わない。本物の SQLite（migration を流したもの）に、本物の監査の書き込みで記録する。
vi.mock("@/lib/config", async (importOriginal) => (await import("./helpers/audit-config")).withAuditKey(await importOriginal()));
const current = vi.hoisted(() => ({ db: undefined as unknown as Db }));
vi.mock("@/lib/db", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/db")>(),
  getDb: async () => current.db
}));

const A40 = readFileSync("tests/fixtures/hl7/a40.hl7").toString();
const TEMP = "ER2026102400";
const STUDY = "2.25.100";

let dir: string;
let template: string;
let n = 0;
let orthanc: FakeOrthanc;
const options = { issuer: "RIS_EMU", allowWrite: true, pollMs: 1 };
const send = (text: string) => processMessage(Buffer.from(text), "192.0.2.1", orthanc.backend, undefined, options);
const a40 = (from: string, to: string) =>
  A40.replace("ER2026102400", from).replace("P000001", to).replace("20261024201530A40A", `A40${++n}`);
const sweep = () => sweepArrivals(orthanc.backend, undefined, options);
const temp = (sop: string) =>
  orthanc.add({ PatientID: TEMP, PatientName: "UNKNOWN^MALE", PatientSex: "M", StudyInstanceUID: STUDY, SOPInstanceUID: sop });
const patientsOf = () => [...new Set(orthanc.instances.map(i => i.PatientID))].sort();

/** データベースのファイルを直に書き換える者の真似。追記だけの trigger を外す */
async function dropGuards(db: Db) {
  await db.$executeRawUnsafe('DROP TRIGGER "AuditLog_no_update"');
  await db.$executeRawUnsafe('DROP TRIGGER "AuditLog_no_delete"');
  await db.$executeRawUnsafe('DROP TRIGGER "AuditLog_no_replace"');
}

/** 鍵を持たない者が、つなぎの末尾に A40 の覚えの行を書き足す（hash は鍵なしで作れる値だけ） */
const forgeAck = (db: Db, remember: Record<string, unknown>, keyless = false) =>
  forgeRow(db, { event: "ack", code: "AA", remember }, keyless);

/** 鍵を持たない者が、つなぎの末尾に HL7 の行を書き足す。keyless なら鍵の無い形の hash、でなければ でたらめの hash */
async function forgeRow(db: Db, detail: Record<string, unknown>, keyless = false) {
  const last = (await db.auditLog.findFirst({ orderBy: { seq: "desc" } }))!;
  const row = {
    seq: last.seq + 1,
    occurredAt: new Date(),
    actorId: "hl7-receiver",
    actorRole: "system",
    authMode: "hl7",
    action: "hl7",
    outcome: "success",
    patientId: null,
    studyInstanceUid: null,
    sourceAddress: null,
    detail: JSON.stringify(detail),
    prevHash: last.hash,
    sourceAddressUnverified: null,
    keyId: keyless ? null : last.keyId
  };
  const hash = keyless ? computeAuditHash(row) : "f".repeat(64);
  await db.auditLog.create({ data: { ...row, hash } });
}

const alias = (at: number) => ({
  kind: "alias", from: TEMP, to: "Q000666", studies: [STUDY], fromNames: [], attributes: {}, at: new Date(at).toISOString()
});

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tsunagi-hl7-history-"));
  template = path.join(dir, "template.db");
  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: `file:${template}`, CHECKPOINT_DISABLE: "1" },
    stdio: "pipe"
  });
}, 60_000);

beforeEach(async () => {
  const file = path.join(dir, `t${++n}.db`);
  copyFileSync(template, file);
  current.db = await createDb(`file:${file}`);
  orthanc = createFakeOrthanc();
});

afterEach(async () => {
  await current.db.$disconnect();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("HL7 の経過の確かめ", () => {
  it("鍵つきの値とつなぎが合えば、覚えを使って見回りが書き換える", async () => {
    temp(`${STUDY}.1.1`);
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    temp(`${STUDY}.2.1`);
    expect((await history()).some(r => r.detail?.remember)).toBe(true);
    expect(await sweep()).toMatchObject({ count: 1 });
    expect(patientsOf()).toEqual(["P000001"]);
  });

  it("鍵の合わない ack の行を使わず、見回りと A40 の適用を止める", async () => {
    temp(`${STUDY}.1.1`);
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    temp(`${STUDY}.2.1`);
    // 覚えの統合の先を、別の患者に書き換える
    await dropGuards(current.db);
    const ack = (await current.db.auditLog.findMany({ orderBy: { seq: "asc" } })).findLast(r => r.detail?.includes("\"remember\""))!;
    const detail = JSON.parse(ack.detail!);
    detail.remember.to = "Q000666";
    await current.db.auditLog.update({ where: { seq: ack.seq }, data: { detail: JSON.stringify(detail) } });

    await expect(history()).rejects.toBeInstanceOf(HistoryTampered);
    const calls = orthanc.modifyCalls.length;
    expect(await sweep()).toMatchObject({ count: 0, blocked: expect.stringContaining("鍵つきの値・つなぎと合わない") });
    orthanc.add({ PatientID: "ER9", StudyInstanceUID: "2.25.900" });
    expect(await send(a40("ER9", "P000009"))).toContain("MSA|AE|");
    expect(orthanc.modifyCalls).toHaveLength(calls);
    expect(patientsOf()).toEqual(["P000001", TEMP, "ER9"].sort());
  });

  it("先の時刻の偽の行は、時計の巻き戻りとして待ち続けず、鍵の不一致として止める", async () => {
    temp(`${STUDY}.1.1`);
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    temp(`${STUDY}.2.1`);
    await forgeAck(current.db, alias(Date.now() + 365 * 24 * 60 * 60 * 1000));
    const result = await sweep();
    expect(result).toMatchObject({ count: 0, blocked: expect.stringContaining("鍵つきの値・つなぎと合わない") });
    expect(result.blocked).not.toContain("時計");
    expect(orthanc.modifyCalls).toHaveLength(1);
  });

  it("鍵の無い形（鍵を持たない者でも作れる hash）の覚えの行は使わない", async () => {
    temp(`${STUDY}.1.1`);
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    await forgeAck(current.db, alias(Date.now()), true);
    await expect(history()).rejects.toThrow("鍵の無い行");
    expect(await sweep()).toMatchObject({ count: 0, blocked: expect.stringContaining("鍵の無い行") });
  });

  it("鍵つきの行の後に書き足した鍵の無い行（偽の照らし合わせ）で、結果不明の書き換えを解かない", async () => {
    temp(`${STUDY}.1.1`);
    // 書き換えを結果不明にする（仕事の状態を読めない）
    orthanc.next.state = "Running";
    expect(await processMessage(Buffer.from(a40(TEMP, "P000001")), "192.0.2.1", orthanc.backend, undefined, { ...options, jobTimeoutMs: 0 }))
      .toContain("MSA|AE|");
    const request = (await history()).find(r => r.detail?.event === "request")!;
    // 鍵を持たない者が、人が解いたことにする行を、鍵の無い形で書き足す
    await forgeRow(current.db, { event: "reconcile", writeId: request.detail?.writeId, manual: true }, true);
    await expect(history()).rejects.toThrow("鍵の無い行");
    orthanc.add({ PatientID: "ER9", StudyInstanceUID: "2.25.900" });
    expect(await send(a40("ER9", "P000009"))).toContain("MSA|AE|");
  });

  it("行の間に差し込んだ行（つなぎの合わない行）は使わない", async () => {
    temp(`${STUDY}.1.1`);
    expect(await send(a40(TEMP, "P000001"))).toContain("MSA|AA|");
    await dropGuards(current.db);
    const rows = await current.db.auditLog.findMany({ orderBy: { seq: "asc" } });
    // 2 行目の prevHash を別の値にする（前の行とのつなぎが切れる）
    await current.db.auditLog.update({ where: { seq: rows[1]!.seq }, data: { prevHash: "e".repeat(64) } });
    await expect(history()).rejects.toThrow("prevHash");
  });
});
