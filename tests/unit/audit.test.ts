import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as auditModule from "@/lib/audit";
import { appendAudit, computeAuditHash, GENESIS_HASH, verifyAuditChain, type AuditEntryInput } from "@/lib/audit";
import { createDb, type Db } from "@/lib/db";

// 監査の記録の試験。migration（trigger を含む）を流した本物の SQLite に対して行う。

let dir: string;
let template: string;
const opened: Db[] = [];

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "tsunagi-audit-"));
  template = path.join(dir, "template.db");
  execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: `file:${template}`, CHECKPOINT_DISABLE: "1" },
    stdio: "pipe",
  });
}, 60_000);

afterEach(async () => {
  await Promise.all(opened.splice(0).map((db) => db.$disconnect()));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function freshDb(): Promise<Db> {
  const file = path.join(dir, `t${++n}.db`);
  copyFileSync(template, file);
  const db = await createDb(`file:${file}`);
  opened.push(db);
  return db;
}

const entry = (i: number): AuditEntryInput => ({
  actorId: "dev",
  actorRole: "doctor",
  authMode: "dev",
  action: "view_study",
  patientId: `JP-TEST-000${(i % 4) + 1}`,
  studyInstanceUid: `1.2.826.0.1.3680043.8.498.${i}`,
  detail: { i },
});

async function appendMany(db: Db, count: number) {
  for (let i = 0; i < count; i++) await appendAudit(db, entry(i));
}

/** データベースのファイルを直に書き換える者の真似。まず追記だけの trigger を外す */
async function dropGuards(db: Db) {
  await db.$executeRawUnsafe('DROP TRIGGER "AuditLog_no_update"');
  await db.$executeRawUnsafe('DROP TRIGGER "AuditLog_no_delete"');
  await db.$executeRawUnsafe('DROP TRIGGER "AuditLog_no_replace"');
}

describe("監査の記録", () => {
  it("誰が・いつ・どの患者と検査に・何をしたを残し、前の行の hash をつなぐ", async () => {
    const db = await freshDb();
    const first = await appendAudit(db, entry(0));
    const second = await appendAudit(db, { ...entry(1), action: "role_switch", detail: { from: "viewer", to: "admin" } });

    expect(first).toMatchObject({
      seq: 1,
      actorId: "dev",
      actorRole: "doctor",
      action: "view_study",
      outcome: "success",
      patientId: "JP-TEST-0001",
      studyInstanceUid: "1.2.826.0.1.3680043.8.498.0",
      prevHash: GENESIS_HASH,
    });
    expect(first.occurredAt).toBeInstanceOf(Date);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.prevHash).toBe(first.hash);
    const { hash, ...rest } = second;
    expect(computeAuditHash(rest)).toBe(hash);
  });

  it("書き換えが無ければ、確かめは通る", async () => {
    const db = await freshDb();
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 0 });
    await appendMany(db, 5);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 5 });
  });

  it("同時に追記しても、つなぎは1本のまま", async () => {
    const db = await freshDb();
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAudit(db, entry(i))));
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 20 });
  });

  it("小分けに読んでも、同じに確かめる", async () => {
    const db = await freshDb();
    await appendMany(db, 7);
    expect(await verifyAuditChain(db, 2)).toEqual({ ok: true, checked: 7 });
  });

  describe("追記だけ", () => {
    it("モジュールには追記と確かめのほかの書き込みの関数が無い", () => {
      const functions = Object.entries(auditModule)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k)
        .sort();
      expect(functions).toEqual(["appendAudit", "computeAuditHash", "verifyAuditChain"]);
    });

    it("データベースの側でも、行の更新を断る", async () => {
      const db = await freshDb();
      await appendMany(db, 2);
      // Prisma は SQLite の RAISE(ABORT) を別の名前の失敗に写すので、文言ではなく、断られて行が残ることを見る
      await expect(db.auditLog.update({ where: { seq: 1 }, data: { action: "delete" } })).rejects.toThrow();
      await expect(db.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = 'delete'`)).rejects.toThrow();
      expect((await db.auditLog.findUniqueOrThrow({ where: { seq: 1 } })).action).toBe("view_study");
      expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 2 });
    });

    it("データベースの側でも、行の削除を断る", async () => {
      const db = await freshDb();
      await appendMany(db, 2);
      await expect(db.auditLog.delete({ where: { seq: 1 } })).rejects.toThrow();
      await expect(db.$executeRawUnsafe('DELETE FROM "AuditLog"')).rejects.toThrow();
      expect(await db.auditLog.count()).toBe(2);
    });

    it("データベースの側でも、INSERT OR REPLACE・REPLACE INTO での置き換えを断る（同じ seq・prevHash・hash）", async () => {
      const db = await freshDb();
      await appendMany(db, 3);
      const before = await db.auditLog.findMany({ orderBy: { seq: "asc" } });
      const second = before[1]!;
      const columns = `"seq","occurredAt","actorId","actorRole","authMode","action","outcome","prevHash","hash"`;
      const forged = (seq: number, prevHash: string, hash: string) =>
        `(${seq}, ${second.occurredAt.getTime()}, 'intruder', 'admin', 'dev', 'delete', 'success', '${prevHash}', '${hash}')`;

      // 同じ seq（ほかの値は新しい）
      await expect(
        db.$executeRawUnsafe(`INSERT OR REPLACE INTO "AuditLog" (${columns}) VALUES ${forged(2, "a".repeat(64), "b".repeat(64))}`),
      ).rejects.toThrow();
      // 同じ prevHash（seq は新しい）
      await expect(
        db.$executeRawUnsafe(`REPLACE INTO "AuditLog" (${columns}) VALUES ${forged(10, second.prevHash, "c".repeat(64))}`),
      ).rejects.toThrow();
      // 同じ hash（seq は新しい）
      await expect(
        db.$executeRawUnsafe(`INSERT OR REPLACE INTO "AuditLog" (${columns}) VALUES ${forged(11, "d".repeat(64), second.hash)}`),
      ).rejects.toThrow();
      // UPSERT（ON CONFLICT DO UPDATE）も断る
      await expect(
        db.$executeRawUnsafe(
          `INSERT INTO "AuditLog" (${columns}) VALUES ${forged(2, "e".repeat(64), "f".repeat(64))} ON CONFLICT("seq") DO UPDATE SET "action" = 'delete'`,
        ),
      ).rejects.toThrow();

      expect(await db.auditLog.findMany({ orderBy: { seq: "asc" } })).toEqual(before);
      expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 3 });
      // 正しい追記はこれまでどおり通る
      await appendAudit(db, entry(3));
      expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 4 });
    });
  });

  describe("確かめていない接続元（X-Forwarded-For など）", () => {
    it("別の欄に残し、hash に含める（書き換えると見つかる）", async () => {
      const db = await freshDb();
      const row = await appendAudit(db, { ...entry(0), sourceAddressUnverified: "198.51.100.7" });
      expect(row).toMatchObject({ sourceAddress: null, sourceAddressUnverified: "198.51.100.7" });
      await appendMany(db, 1);
      expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 2 });

      await dropGuards(db);
      await db.$executeRawUnsafe(`UPDATE "AuditLog" SET "sourceAddressUnverified" = '192.0.2.99' WHERE "seq" = 1`);
      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 1 });
    });

    it("値の無い行の hash は、欄を足す前の並びと同じ（古い行の確かめ方を変えない）", () => {
      const base = {
        seq: 1,
        occurredAt: new Date("2026-10-18T00:00:00Z"),
        actorId: "dev",
        actorRole: "viewer",
        authMode: "dev",
        action: "search",
        outcome: "success",
        patientId: null,
        studyInstanceUid: null,
        sourceAddress: null,
        detail: null,
        prevHash: GENESIS_HASH,
      };
      // 欄を足す前の並び（12 の値）の SHA-256
      const before = createHash("sha256")
        .update(JSON.stringify([1, "2026-10-18T00:00:00.000Z", "dev", "viewer", "dev", "search", "success", null, null, null, null, GENESIS_HASH]))
        .digest("hex");
      expect(computeAuditHash(base)).toBe(before);
      expect(computeAuditHash({ ...base, sourceAddressUnverified: null })).toBe(before);
      expect(computeAuditHash({ ...base, sourceAddressUnverified: "198.51.100.7" })).not.toBe(computeAuditHash(base));
    });
  });

  describe("書き換えを見つける", () => {
    it("行の中身を書き換えると見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 5);
      await dropGuards(db);
      await db.$executeRawUnsafe(`UPDATE "AuditLog" SET "patientId" = 'JP-TEST-9999' WHERE "seq" = 3`);

      expect(await verifyAuditChain(db)).toEqual({
        ok: false,
        checked: 2,
        seq: 3,
        reason: expect.stringContaining("書き換えられた"),
      });
    });

    it("時刻だけを書き換えても見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 3);
      await dropGuards(db);
      await db.auditLog.update({ where: { seq: 2 }, data: { occurredAt: new Date("2020-01-01T00:00:00Z") } });

      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 2 });
    });

    it("書き換えた行の hash を計算し直しても、次の行で見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 5);
      await dropGuards(db);
      const row = await db.auditLog.findUniqueOrThrow({ where: { seq: 3 } });
      const forged = { ...row, action: "search" };
      await db.auditLog.update({ where: { seq: 3 }, data: { action: "search", hash: computeAuditHash(forged) } });

      expect(await verifyAuditChain(db)).toEqual({
        ok: false,
        checked: 3,
        seq: 4,
        reason: expect.stringContaining("prevHash"),
      });
    });

    it("途中の行を消すと見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 5);
      await dropGuards(db);
      await db.auditLog.delete({ where: { seq: 3 } });

      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 3, reason: expect.stringContaining("無い") });
    });

    it("つなぎに合わない行を差し込むと見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 2);
      const base = {
        seq: 3,
        occurredAt: new Date(),
        actorId: "intruder",
        actorRole: "admin",
        authMode: "dev",
        action: "delete",
        outcome: "success",
        patientId: null,
        studyInstanceUid: null,
        sourceAddress: null,
        detail: null,
        prevHash: "f".repeat(64),
      };
      await db.auditLog.create({ data: { ...base, hash: computeAuditHash(base) } });

      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 3 });
    });
  });
});
