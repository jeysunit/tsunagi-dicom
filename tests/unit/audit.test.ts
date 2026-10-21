import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as auditModule from "@/lib/audit";
import {
  appendAudit,
  computeAuditHash,
  computeAuditMac,
  GENESIS_HASH,
  verifyAuditChain,
  type AuditEntryInput,
  type AuditRow,
} from "@/lib/audit";
import { AuditAnchorFileError, readAuditAnchors, resetAuditAnchorState, writeAuditAnchor } from "@/lib/audit-anchor";
import { auditKeyringFrom, deriveAuditKey } from "@/lib/audit-key";
import { createDb, type Db } from "@/lib/db";
import { auditTestConfig } from "./helpers/audit-config";

// 監査の記録の試験。migration（trigger を含む）を流した本物の SQLite に対して行う。
// つなぎの鍵は設定の SESSION_SECRET から導くので、試験だけの値に差し替える（tests/unit/helpers/audit-config.ts）。
vi.mock("@/lib/config", async (importOriginal) => (await import("./helpers/audit-config")).withAuditKey(await importOriginal()));

const SECRET = auditTestConfig.sessionSecret;
const key = () => deriveAuditKey(auditTestConfig.sessionSecret);
/** 書き換えの無いつなぎの確かめの結果（鍵の無い行の数と、照らした控え） */
const okChain = (checked: number, legacy = 0, anchors = { checked: 0, latestSeq: null as number | null }) => ({
  ok: true,
  checked,
  legacy,
  anchors,
});

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
    // hash は鍵つきの HMAC-SHA256。行には鍵の印を持つ（鍵そのものは持たない）
    const { hash, ...rest } = second;
    expect(second.keyId).toBe(key().id);
    expect(computeAuditMac(rest, key())).toBe(hash);
    expect(computeAuditHash(rest)).not.toBe(hash);
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(SECRET);
  });

  it("書き換えが無ければ、確かめは通る", async () => {
    const db = await freshDb();
    expect(await verifyAuditChain(db)).toEqual(okChain(0));
    await appendMany(db, 5);
    expect(await verifyAuditChain(db)).toEqual(okChain(5));
  });

  it("同時に追記しても、つなぎは1本のまま", async () => {
    const db = await freshDb();
    await Promise.all(Array.from({ length: 20 }, (_, i) => appendAudit(db, entry(i))));
    expect(await verifyAuditChain(db)).toEqual(okChain(20));
  });

  it("小分けに読んでも、同じに確かめる", async () => {
    const db = await freshDb();
    await appendMany(db, 7);
    expect(await verifyAuditChain(db, 2)).toEqual(okChain(7));
  });

  describe("追記だけ", () => {
    it("モジュールには追記と確かめのほかの書き込みの関数が無い", () => {
      const functions = Object.entries(auditModule)
        .filter(([, v]) => typeof v === "function")
        .map(([k]) => k)
        .sort();
      // appendAuditWith は、BFF のデータベースの変更と記録の1行の追記を、1つの transaction で書くもの（段 2）。
      // appendAuditIf は、同じ並びの中で「もう書いてあれば書かない」を確かめてから追記するもの（段 4）。
      // 記録の行は追記するだけで、更新・削除はしない
      // computeAuditMac・computeAuditHash は hash の計算だけで、データベースに書かない
      expect(functions).toEqual(["appendAudit", "appendAuditIf", "appendAuditWith", "computeAuditHash", "computeAuditMac", "verifyAuditChain"]);
    });

    it("appendAuditIf：書かないと決めたら行を足さず、書くときは同じつなぎに足す", async () => {
      const db = await freshDb();
      const input: AuditEntryInput = { actorId: "alice", actorRole: "admin", authMode: "dev", action: "send" };
      expect((await auditModule.appendAuditIf(db, async () => ({ value: 1, input: null }))).row).toBeNull();
      expect(await db.auditLog.count()).toBe(0);
      const { row } = await auditModule.appendAuditIf(db, async () => ({ value: 2, input }));
      expect(row).toMatchObject({ seq: 1, action: "send" });
      expect(await verifyAuditChain(db)).toEqual(okChain(1));
    });

    it("データベースの側でも、行の更新を断る", async () => {
      const db = await freshDb();
      await appendMany(db, 2);
      // Prisma は SQLite の RAISE(ABORT) を別の名前の失敗に写すので、文言ではなく、断られて行が残ることを見る
      await expect(db.auditLog.update({ where: { seq: 1 }, data: { action: "delete" } })).rejects.toThrow();
      await expect(db.$executeRawUnsafe(`UPDATE "AuditLog" SET "action" = 'delete'`)).rejects.toThrow();
      expect((await db.auditLog.findUniqueOrThrow({ where: { seq: 1 } })).action).toBe("view_study");
      expect(await verifyAuditChain(db)).toEqual(okChain(2));
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
      expect(await verifyAuditChain(db)).toEqual(okChain(3));
      // 正しい追記はこれまでどおり通る
      await appendAudit(db, entry(3));
      expect(await verifyAuditChain(db)).toEqual(okChain(4));
    });
  });

  describe("確かめていない接続元（X-Forwarded-For など）", () => {
    it("別の欄に残し、hash に含める（書き換えると見つかる）", async () => {
      const db = await freshDb();
      const row = await appendAudit(db, { ...entry(0), sourceAddressUnverified: "198.51.100.7" });
      expect(row).toMatchObject({ sourceAddress: null, sourceAddressUnverified: "198.51.100.7" });
      await appendMany(db, 1);
      expect(await verifyAuditChain(db)).toEqual(okChain(2));

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

    it("鍵を持たない者が hash を計算し直しても、その行で見つかる（鍵の無い SHA-256・別の鍵）", async () => {
      for (const recompute of [
        (row: Omit<AuditRow, "hash">) => computeAuditHash(row),
        (row: Omit<AuditRow, "hash">) => computeAuditMac(row, { ...deriveAuditKey("x".repeat(48)), id: row.keyId! }),
      ]) {
        const db = await freshDb();
        await appendMany(db, 5);
        await dropGuards(db);
        const { hash: _hash, ...row } = await db.auditLog.findUniqueOrThrow({ where: { seq: 3 } });
        await db.auditLog.update({ where: { seq: 3 }, data: { action: "search", hash: recompute({ ...row, action: "search" }) } });

        expect(await verifyAuditChain(db)).toEqual({
          ok: false,
          checked: 2,
          seq: 3,
          reason: expect.stringContaining("書き換えられた"),
        });
      }
    });

    it("鍵を持つ者が1行だけ計算し直しても、次の行で見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 5);
      await dropGuards(db);
      const { hash: _hash, ...row } = await db.auditLog.findUniqueOrThrow({ where: { seq: 3 } });
      await db.auditLog.update({ where: { seq: 3 }, data: { action: "search", hash: computeAuditMac({ ...row, action: "search" }, key()) } });

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

    it("鍵を持たない者が、行を鍵の無い形に書き換えて末尾まで作り直しても見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 5);
      await dropGuards(db);
      // 3 行目から末尾までを、鍵の無い SHA-256 の行（keyId を空）として作り直す
      let prevHash = (await db.auditLog.findUniqueOrThrow({ where: { seq: 2 } })).hash;
      for (let seq = 3; seq <= 5; seq++) {
        const { hash: _hash, ...row } = await db.auditLog.findUniqueOrThrow({ where: { seq } });
        const forged = { ...row, patientId: "JP-TEST-9999", prevHash, keyId: null };
        prevHash = computeAuditHash(forged);
        await db.auditLog.update({ where: { seq }, data: { patientId: "JP-TEST-9999", prevHash: forged.prevHash, keyId: null, hash: prevHash } });
      }
      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 3, reason: expect.stringContaining("鍵の無い行") });
    });

    it("行の鍵の印を、ほかの鍵の印に書き換えると見つかる", async () => {
      const db = await freshDb();
      await appendMany(db, 2);
      await dropGuards(db);
      const other = deriveAuditKey("y".repeat(48));
      const { hash: _hash, ...row } = await db.auditLog.findUniqueOrThrow({ where: { seq: 2 } });
      // 自分の鍵で計算し直しても、その鍵は確かめる側に無い
      await db.auditLog.update({ where: { seq: 2 }, data: { keyId: other.id, hash: computeAuditMac({ ...row, keyId: other.id }, other) } });
      expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 2, reason: expect.stringContaining("鍵") });
    });
  });
});

describe("先頭の控え（データベースの外）と照らす", () => {
  let anchorDir: string;
  beforeAll(() => {
    anchorDir = mkdtempSync(path.join(tmpdir(), "tsunagi-anchor-"));
  });
  afterAll(() => rmSync(anchorDir, { recursive: true, force: true }));
  let m = 0;
  const anchorFile = () => path.join(anchorDir, `a${++m}.jsonl`);

  it("控えを、ログ（1行）とファイル（JSON Lines の追記）に書き出す。先頭が変わらなければ重ねて書かない", async () => {
    resetAuditAnchorState();
    const db = await freshDb();
    const file = anchorFile();
    const lines: string[] = [];
    expect(await writeAuditAnchor(db, file, (l) => lines.push(l))).toBeNull();
    await appendMany(db, 3);
    const first = await writeAuditAnchor(db, file, (l) => lines.push(l), new Date("2026-10-21T00:00:00Z"));
    const last = await db.auditLog.findUniqueOrThrow({ where: { seq: 3 } });
    expect(first).toEqual({ seq: 3, hash: last.hash, keyId: key().id, at: "2026-10-21T00:00:00.000Z" });
    expect(await writeAuditAnchor(db, file, (l) => lines.push(l))).toBeNull();
    await appendMany(db, 1);
    await writeAuditAnchor(db, file, (l) => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^tsunagi-dicom: audit-anchor \{"seq":3,/);
    expect(await readAuditAnchors(file)).toEqual([
      { seq: 3, hash: last.hash },
      { seq: 4, hash: (await db.auditLog.findUniqueOrThrow({ where: { seq: 4 } })).hash },
    ]);
    // 控えと照らして通る
    expect(await verifyAuditChain(db, 1000, { anchors: await readAuditAnchors(file) })).toEqual(okChain(4, 0, { checked: 2, latestSeq: 4 }));
  });

  it("末尾を消す（切り詰め）と、つなぎだけでは見つからないが、控えと照らすと見つかる", async () => {
    resetAuditAnchorState();
    const db = await freshDb();
    const file = anchorFile();
    await appendMany(db, 5);
    await writeAuditAnchor(db, file, () => undefined);
    await dropGuards(db);
    await db.$executeRawUnsafe('DELETE FROM "AuditLog" WHERE "seq" >= 4');

    expect(await verifyAuditChain(db)).toEqual(okChain(3));
    expect(await verifyAuditChain(db, 1000, { anchors: await readAuditAnchors(file) })).toMatchObject({
      ok: false,
      seq: 4,
      reason: expect.stringContaining("末尾が消された"),
    });
  });

  it("鍵を持つ者が末尾まで作り直しても、つなぎだけでは見つからないが、控えと照らすと見つかる", async () => {
    resetAuditAnchorState();
    const db = await freshDb();
    const file = anchorFile();
    await appendMany(db, 5);
    await writeAuditAnchor(db, file, () => undefined);
    await dropGuards(db);
    let prevHash = (await db.auditLog.findUniqueOrThrow({ where: { seq: 3 } })).hash;
    for (let seq = 4; seq <= 5; seq++) {
      const { hash: _hash, ...row } = await db.auditLog.findUniqueOrThrow({ where: { seq } });
      const forged = { ...row, action: "search", prevHash };
      prevHash = computeAuditMac(forged, key());
      await db.auditLog.update({ where: { seq }, data: { action: "search", prevHash: forged.prevHash, hash: prevHash } });
    }

    expect(await verifyAuditChain(db)).toEqual(okChain(5));
    expect(await verifyAuditChain(db, 1000, { anchors: await readAuditAnchors(file) })).toMatchObject({
      ok: false,
      seq: 5,
      reason: expect.stringContaining("控え"),
    });
  });

  it("控えのファイル：まだ無ければ空。読めない行・同じ seq で食い違う控えは、書き換えとして断る", async () => {
    expect(await readAuditAnchors(path.join(anchorDir, "none.jsonl"))).toEqual([]);
    const bad = anchorFile();
    writeFileSync(bad, `${JSON.stringify({ seq: 1, hash: "a".repeat(64) })}\nnot json\n`);
    await expect(readAuditAnchors(bad)).rejects.toThrow(AuditAnchorFileError);
    await expect(readAuditAnchors(bad)).rejects.toThrow("2 行目");
    const twice = anchorFile();
    writeFileSync(twice, `${JSON.stringify({ seq: 1, hash: "a".repeat(64) })}\n${JSON.stringify({ seq: 1, hash: "b".repeat(64) })}\n`);
    await expect(readAuditAnchors(twice)).rejects.toThrow("食い違って");
  });
});

describe("鍵つきにする前の行からの移り方と、鍵の取り替え", () => {
  afterEach(() => {
    auditTestConfig.sessionSecret = SECRET;
    auditTestConfig.audit.sessionSecretPrevious = [];
  });

  it("既存のデータベース（鍵の無い SHA-256 の行）に migration を当てて起動しても、確かめは通り、次の行から鍵つきになる", async () => {
    // この版より前の migration だけを当てたデータベースに、前の版の形の行（鍵の無い SHA-256）を書く
    const migrationsDir = path.resolve("prisma/migrations");
    const KEYED = "20261021120000_audit_log_keyed_chain";
    const names = readdirSync(migrationsDir).filter((n) => /^\d{14}_/.test(n)).sort();
    const file = path.join(dir, `legacy${++n}.db`);
    const raw = new DatabaseSync(file);
    for (const name of names.filter((x) => x < KEYED)) raw.exec(readFileSync(path.join(migrationsDir, name, "migration.sql"), "utf8"));
    let prevHash = GENESIS_HASH;
    for (let seq = 1; seq <= 3; seq++) {
      const row = {
        seq,
        occurredAt: new Date(Date.UTC(2026, 9, 18, 0, 0, seq)),
        actorId: "dev",
        actorRole: "viewer",
        authMode: "dev",
        action: "search",
        outcome: "success",
        patientId: null,
        studyInstanceUid: null,
        sourceAddress: null,
        detail: null,
        prevHash,
      };
      const hash = computeAuditHash(row);
      raw
        .prepare(
          `INSERT INTO "AuditLog" ("seq","occurredAt","actorId","actorRole","authMode","action","outcome","prevHash","hash") VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(seq, row.occurredAt.getTime(), row.actorId, row.actorRole, row.authMode, row.action, row.outcome, prevHash, hash);
      prevHash = hash;
    }
    // この版の migration を当てる
    raw.exec(readFileSync(path.join(migrationsDir, KEYED, "migration.sql"), "utf8"));
    raw.close();

    const db = await createDb(`file:${file}`);
    opened.push(db);
    expect(await verifyAuditChain(db)).toEqual(okChain(3, 3));
    // 次の追記で、鍵が替わったこと（sha256 → 鍵の印）を1行書いてから、鍵つきの行を足す
    await appendAudit(db, entry(0));
    const rows = await db.auditLog.findMany({ orderBy: { seq: "asc" } });
    expect(rows.map((r) => [r.seq, r.action, r.keyId])).toEqual([
      [1, "search", null],
      [2, "search", null],
      [3, "search", null],
      [4, "audit_key", key().id],
      [5, "view_study", key().id],
    ]);
    expect(JSON.parse(rows[3]!.detail!)).toEqual({ from: "sha256", to: key().id });
    expect(rows[3]!.prevHash).toBe(rows[2]!.hash);
    expect(await verifyAuditChain(db)).toEqual(okChain(5, 3));
  });

  it("SESSION_SECRET を替えると、鍵が替わったことを1行書く。前の値を渡さなければ前の行は確かめられず、渡せば通る", async () => {
    const db = await freshDb();
    await appendMany(db, 2);
    const before = key();
    auditTestConfig.sessionSecret = "z".repeat(48);
    await appendMany(db, 1);
    const after = key();
    const rows = await db.auditLog.findMany({ orderBy: { seq: "asc" } });
    expect(rows.map((r) => [r.action, r.keyId])).toEqual([
      ["view_study", before.id],
      ["view_study", before.id],
      ["audit_key", after.id],
      ["view_study", after.id],
    ]);
    expect(JSON.parse(rows[2]!.detail!)).toEqual({ from: before.id, to: after.id });

    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 1, reason: expect.stringContaining("SESSION_SECRET_PREVIOUS_FILE") });
    auditTestConfig.audit.sessionSecretPrevious = [SECRET];
    expect(await verifyAuditChain(db)).toEqual(okChain(4));
    // 鍵の束を直に渡しても同じ
    expect(await verifyAuditChain(db, 1000, { keyring: auditKeyringFrom("z".repeat(48), [SECRET]) })).toEqual(okChain(4));
  });
});
