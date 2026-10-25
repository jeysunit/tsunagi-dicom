import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const okChain = (checked: number, legacy = 0, anchors?: { checked: number; latestSeq: number }) => ({
  ok: true,
  checked,
  legacy,
  // 控えを渡さなければ、照らしていないことが分かる（行が無ければ no-rows）
  anchors: anchors
    ? { status: "checked", ...anchors }
    : { status: checked === 0 ? "no-rows" : "not-configured", checked: 0, latestSeq: null },
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

    it("verifyAuditChain の onRow：確かめた行だけを順に渡し、食い違いの行からは渡さない", async () => {
      const db = await freshDb();
      await appendMany(db, 3);
      const seen: number[] = [];
      expect(await verifyAuditChain(db, 2, { onRow: (r) => seen.push(r.seq) })).toEqual(okChain(3));
      expect(seen).toEqual([1, 2, 3]);
      await dropGuards(db);
      await db.auditLog.update({ where: { seq: 2 }, data: { action: "login" } });
      seen.length = 0;
      expect(await verifyAuditChain(db, 2, { onRow: (r) => seen.push(r.seq) })).toMatchObject({ ok: false, seq: 2 });
      expect(seen).toEqual([1]);
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
    // 初めての起動（記録も利用者もまだ無い）：控えのファイルを作り、作ったこと（audit_anchor）を1行書いてから、その行を控える
    const first = await writeAuditAnchor(db, file, (l) => lines.push(l), new Date("2026-10-21T00:00:00Z"));
    const start = await db.auditLog.findUniqueOrThrow({ where: { seq: 1 } });
    expect(start).toMatchObject({ action: "audit_anchor", actorId: "system", keyId: key().id });
    expect(JSON.parse(start.detail!)).toEqual({ event: "start" });
    expect(first).toEqual({ seq: 1, hash: start.hash, keyId: key().id, at: "2026-10-21T00:00:00.000Z" });
    expect(await writeAuditAnchor(db, file, (l) => lines.push(l))).toBeNull();
    await appendMany(db, 3);
    await writeAuditAnchor(db, file, (l) => lines.push(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^tsunagi-dicom: audit-anchor \{"seq":1,/);
    expect(await readAuditAnchors(file)).toEqual([
      { seq: 1, hash: start.hash },
      { seq: 4, hash: (await db.auditLog.findUniqueOrThrow({ where: { seq: 4 } })).hash },
    ]);
    // 控えと照らして通る
    expect(await verifyAuditChain(db, 1000, { anchors: await readAuditAnchors(file), requireAnchors: true })).toEqual(
      okChain(4, 0, { checked: 2, latestSeq: 4 }),
    );
  });

  it("記録があるのに控えのファイルが無ければ、作らない（データベースを書き換えて初めてを装わせない）。空のファイルを置けば始める", async () => {
    resetAuditAnchorState();
    const db = await freshDb();
    const file = anchorFile();
    await appendMany(db, 3);
    const logged: string[] = [];
    await expect(writeAuditAnchor(db, file, (l) => logged.push(l))).rejects.toThrow("作らない");
    // 作らなかったことを記録に残し、ログには書く
    expect(await db.auditLog.findUniqueOrThrow({ where: { seq: 4 } })).toMatchObject({ action: "audit_anchor", outcome: "denied" });
    expect(logged).toEqual([expect.stringMatching(/^tsunagi-dicom: audit-anchor \{"seq":4,/)]);
    expect(await readAuditAnchors(file)).toEqual([]);
    // 前の版から上げたときなど：施設が空のファイルを置くと、そこへ書く
    writeFileSync(file, "");
    expect((await writeAuditAnchor(db, file, () => undefined))?.seq).toBe(4);
    expect(await verifyAuditChain(db, 1000, { anchors: await readAuditAnchors(file), requireAnchors: true })).toEqual(
      okChain(4, 0, { checked: 1, latestSeq: 4 }),
    );
  });

  it("前に書き出した控えのファイルが消えたら、黙って作り直さない。空のファイルを置けば、追記を続ける", async () => {
    resetAuditAnchorState();
    const db = await freshDb();
    const file = anchorFile();
    // 初めての起動で控えのファイルを作り（1 行目が作ったことの行）、記録を足して控える
    await writeAuditAnchor(db, file, () => undefined);
    await appendMany(db, 2);
    await writeAuditAnchor(db, file, () => undefined);
    rmSync(file);
    await appendMany(db, 1);
    // ログ（標準出力）には書き続け、ファイルは作り直さずに誤りにする
    const logged: string[] = [];
    await expect(writeAuditAnchor(db, file, (l) => logged.push(l))).rejects.toThrow(AuditAnchorFileError);
    expect(logged).toEqual([expect.stringMatching(/^tsunagi-dicom: audit-anchor \{"seq":4,/)]);
    expect(await readAuditAnchors(file)).toEqual([]);
    expect(await verifyAuditChain(db, 1000, { anchors: [], requireAnchors: true })).toMatchObject({ ok: false });
    // 施設が外に残した控えと照らしてから、空のファイルを置いて続ける
    writeFileSync(file, "");
    const next = await writeAuditAnchor(db, file, () => undefined);
    expect(next?.seq).toBe(4);
    expect(await db.auditLog.count({ where: { action: "audit_anchor" } })).toBe(1);
  });

  it("末尾を消す（切り詰め）と、つなぎだけでは見つからないが、控えと照らすと見つかる", async () => {
    resetAuditAnchorState();
    const db = await freshDb();
    const file = anchorFile();
    // 施設が置いた空の控えのファイルへ書く（作ったことの行は足さない）
    writeFileSync(file, "");
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
    writeFileSync(file, "");
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

  it("控えのファイルを設定しているのに控えが無ければ（消えた・別のファイル）、照らさずに通さない", async () => {
    const db = await freshDb();
    // 行がまだ無ければ、控えが無くてよい
    expect(await verifyAuditChain(db, 1000, { anchors: [], requireAnchors: true })).toEqual(okChain(0));
    await appendMany(db, 3);
    // 控えのファイルが消えた後に、末尾を消した（つなぎだけでは見つからない）
    await dropGuards(db);
    await db.$executeRawUnsafe('DELETE FROM "AuditLog" WHERE "seq" = 3');
    const missing = await readAuditAnchors(path.join(anchorDir, "lost.jsonl"));
    expect(await verifyAuditChain(db, 1000, { anchors: missing, requireAnchors: true })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("先頭の控えが無い"),
    });
    // 控えのファイルを設定していなければ、控えとは照らさない（つなぎだけを確かめる）
    expect(await verifyAuditChain(db, 1000, { anchors: missing })).toEqual(okChain(2));
  });

  it("初めて控えのファイルを作れなかったら、作ったことを記録に残さず、作れるようになった次の回に作る", async () => {
    resetAuditAnchorState();
    const db = await freshDb();
    const sub = path.join(anchorDir, `later${++m}`);
    const file = path.join(sub, "anchors.jsonl");
    // 初めての起動で、置き場のフォルダがまだ無い（ボリュームをつなぎ忘れた、など）
    await expect(writeAuditAnchor(db, file, () => undefined)).rejects.toThrow();
    expect(await db.auditLog.count()).toBe(0);
    mkdirSync(sub);
    const first = await writeAuditAnchor(db, file, () => undefined);
    expect(first?.seq).toBe(1);
    expect(await readAuditAnchors(file)).toEqual([{ seq: 1, hash: first!.hash }]);
    // 置き場の書き込みに失敗しても、ログ（標準出力）には書く
    rmSync(file);
    mkdirSync(file);
    await appendMany(db, 1);
    const logged: string[] = [];
    await expect(writeAuditAnchor(db, file, (l) => logged.push(l))).rejects.toThrow();
    expect(logged).toEqual([expect.stringMatching(/^tsunagi-dicom: audit-anchor \{"seq":2,/)]);
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

/** 鍵を持つ者の真似：末尾に1行を、その鍵で書き足す（trigger は外してある前提） */
async function forgeAppend(db: Db, key: ReturnType<typeof deriveAuditKey>, extra: Partial<AuditRow> = {}) {
  const last = await db.auditLog.findFirstOrThrow({ orderBy: { seq: "desc" } });
  const base = {
    seq: last.seq + 1,
    occurredAt: new Date(),
    actorId: "intruder",
    actorRole: "admin",
    authMode: "local",
    action: "view_study",
    outcome: "success",
    patientId: "JP-TEST-0001",
    studyInstanceUid: null,
    sourceAddress: null,
    detail: null,
    prevHash: last.hash,
    sourceAddressUnverified: null,
    keyId: key.id,
    ...extra,
  };
  await db.auditLog.create({ data: { ...base, hash: computeAuditMac(base, key) } });
}

describe("鍵の取り替えと、鍵の無い形への作り直しを悪用させない", () => {
  afterEach(() => {
    auditTestConfig.sessionSecret = SECRET;
    auditTestConfig.audit.sessionSecretPrevious = [];
  });

  /** 鍵 A で 2 行、鍵 B に替えて 1 行（と鍵が替わったことの行）。確かめる側は A を前の鍵として受ける */
  async function rotated() {
    const db = await freshDb();
    await appendMany(db, 2);
    const a = key();
    auditTestConfig.sessionSecret = "b".repeat(48);
    await appendMany(db, 1);
    auditTestConfig.audit.sessionSecretPrevious = [SECRET];
    expect(await verifyAuditChain(db)).toEqual(okChain(4));
    await dropGuards(db);
    return { db, a, b: key() };
  }

  it("取り替えた後に、前の鍵（漏れたかもしれない）を名乗って行を書き足すと見つかる", async () => {
    const { db, a } = await rotated();
    await forgeAppend(db, a);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 5, reason: expect.stringContaining("鍵が替わったことの行が無い") });
  });

  it("前の鍵で「鍵が替わった」行を作って、前の鍵に戻すと見つかる", async () => {
    const { db, a, b } = await rotated();
    await forgeAppend(db, a, { actorId: "system", action: "audit_key", detail: JSON.stringify({ from: b.id, to: a.id }) });
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 5, reason: expect.stringContaining("使い終えた鍵") });
  });

  it("鎖にまだ出ていない、設定で古い鍵へ切り替える行を作っても見つかる（前の鍵が漏れていても）", async () => {
    // いまの鍵 B だけで書いた鎖。設定には前の鍵 A（この鎖では使っていない）が残っている
    auditTestConfig.sessionSecret = "b".repeat(48);
    const db = await freshDb();
    await appendMany(db, 2);
    const b = key();
    const a = deriveAuditKey(SECRET);
    auditTestConfig.audit.sessionSecretPrevious = [SECRET];
    expect(await verifyAuditChain(db)).toEqual(okChain(2));
    await dropGuards(db);
    await forgeAppend(db, a, { actorId: "system", action: "audit_key", detail: JSON.stringify({ from: b.id, to: a.id }) });
    await forgeAppend(db, a);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 3, reason: expect.stringContaining("前の鍵") });
  });

  it("鍵が替わったことの行の、前の鍵と新しい鍵が鎖と合わなければ見つかる（鍵を持つ者が作っても）", async () => {
    const { db, b } = await rotated();
    const c = deriveAuditKey("c".repeat(48));
    // c をいまの鍵（いちばん新しい）にし、a・b を前の鍵として渡す
    auditTestConfig.sessionSecret = "c".repeat(48);
    auditTestConfig.audit.sessionSecretPrevious = [SECRET, "b".repeat(48)];
    // from が前の行の鍵（b）でない
    await forgeAppend(db, c, { actorId: "system", action: "audit_key", detail: JSON.stringify({ from: "sha256", to: c.id }) });
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 5, reason: expect.stringContaining("鎖と合わない") });
    expect(b.id).not.toBe(c.id);
  });

  it("鍵の印が替わったのに、鍵が替わったことの行でなければ見つかる（受け付ける鍵でも）", async () => {
    const db = await freshDb();
    await appendMany(db, 2);
    await dropGuards(db);
    const other = deriveAuditKey("o".repeat(48));
    auditTestConfig.audit.sessionSecretPrevious = ["o".repeat(48)];
    await forgeAppend(db, other);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 3, reason: expect.stringContaining("鍵が替わったことの行が無い") });
  });

  it("鍵つきにした後の行の前にある、鍵の無い行（前の版の行）を作り直すと、鍵が替わったことの行で見つかる", async () => {
    const db = await freshDb();
    // 前の版の行の真似（鍵の無い SHA-256）を 2 行、その後に鍵つきの追記（鍵が替わったことの行と、その行）
    await dropGuards(db);
    let prevHash = GENESIS_HASH;
    for (let seq = 1; seq <= 2; seq++) {
      const row = { ...legacyRow(seq), prevHash };
      prevHash = computeAuditHash(row);
      await db.auditLog.create({ data: { ...row, hash: prevHash } });
    }
    await appendAudit(db, entry(0));
    expect(await verifyAuditChain(db)).toEqual(okChain(4, 2));
    // 前の版の行を書き換え、鍵の無い行どうしのつなぎを作り直す（鍵は要らない）
    prevHash = GENESIS_HASH;
    for (let seq = 1; seq <= 2; seq++) {
      const row = { ...legacyRow(seq), actorId: "intruder", prevHash };
      prevHash = computeAuditHash(row);
      await db.auditLog.update({ where: { seq }, data: { actorId: "intruder", prevHash: row.prevHash, hash: prevHash } });
    }
    // 鍵が替わったことの行（鍵つき）は、前の版の最後の行の hash を prevHash に持つので、作り直しが見つかる
    expect(await verifyAuditChain(db)).toMatchObject({ ok: false, seq: 3, reason: expect.stringContaining("prevHash") });
  });

  it("前の版から上げた一式：鍵が替わったらすぐ控えを書き出すので、切り替えの後を鍵の無い形に作り直しても見つかる", async () => {
    resetAuditAnchorState();
    const anchorDir = mkdtempSync(path.join(tmpdir(), "tsunagi-upgrade-"));
    try {
      const db = await freshDb();
      const file = path.join(anchorDir, "anchors.jsonl");
      // 前の版の行（鍵の無い SHA-256）が 2 行。施設が空の控えのファイルを置き、起動の時の控え（前の版の末尾）を書く
      await dropGuards(db);
      let prevHash = GENESIS_HASH;
      for (let seq = 1; seq <= 2; seq++) {
        const row = { ...legacyRow(seq), prevHash };
        prevHash = computeAuditHash(row);
        await db.auditLog.create({ data: { ...row, hash: prevHash } });
      }
      writeFileSync(file, "");
      auditTestConfig.audit.anchorFile = file;
      await writeAuditAnchor(db, file, () => undefined);
      // 最初の追記で鍵が替わる（3 行目が鍵が替わったことの行）。その直後に控えを書き出す
      await appendAudit(db, entry(0));
      expect((await readAuditAnchors(file)).map((a) => a.seq)).toEqual([2, 4]);
      // 次の定期の書き出しの前に、切り替えの後の行を鍵の無い形に作り直す
      prevHash = (await db.auditLog.findUniqueOrThrow({ where: { seq: 2 } })).hash;
      for (let seq = 3; seq <= 4; seq++) {
        const { hash: _hash, ...row } = await db.auditLog.findUniqueOrThrow({ where: { seq } });
        const forged = { ...row, prevHash, keyId: null };
        prevHash = computeAuditHash(forged);
        await db.auditLog.update({ where: { seq }, data: { prevHash: forged.prevHash, keyId: null, hash: prevHash } });
      }
      expect(await verifyAuditChain(db)).toEqual(okChain(4, 4));
      expect(await verifyAuditChain(db, 1000, { anchors: await readAuditAnchors(file), requireAnchors: true })).toMatchObject({
        ok: false,
        seq: 3,
        reason: expect.stringContaining("控えより後に、鍵の無い行"),
      });
      // 切り替えの後の控えを書けなかった（前の版の末尾の控えしか無い）ときも、控えより後の鍵の無い行として見つかる
      expect(await verifyAuditChain(db, 1000, { anchors: [{ seq: 2, hash: (await db.auditLog.findUniqueOrThrow({ where: { seq: 2 } })).hash }] })).toMatchObject({
        ok: false,
        seq: 3,
        reason: expect.stringContaining("控えより後に、鍵の無い行"),
      });
    } finally {
      auditTestConfig.audit.anchorFile = undefined;
      rmSync(anchorDir, { recursive: true, force: true });
    }
  });

  it("鍵つきの行を消して、全部を鍵の無い形に作り直すと、つなぎだけでは通るが、控えと照らすと見つかる（照らしていないことも分かる）", async () => {
    resetAuditAnchorState();
    const anchorDir = mkdtempSync(path.join(tmpdir(), "tsunagi-downgrade-"));
    try {
      const db = await freshDb();
      const file = path.join(anchorDir, "anchors.jsonl");
      // 初めての起動で控えのファイルを作り（1 行目）、記録を足して控える（4 行目）
      await writeAuditAnchor(db, file, () => undefined);
      await appendMany(db, 3);
      await writeAuditAnchor(db, file, () => undefined);
      await dropGuards(db);
      let prevHash = GENESIS_HASH;
      for (let seq = 1; seq <= 4; seq++) {
        const { hash: _hash, ...row } = await db.auditLog.findUniqueOrThrow({ where: { seq } });
        const forged = { ...row, prevHash, keyId: null };
        prevHash = computeAuditHash(forged);
        await db.auditLog.update({ where: { seq }, data: { prevHash: forged.prevHash, keyId: null, hash: prevHash } });
      }
      // 控えと照らさなければ通るが、照らしていないこと（not-configured）が答えに出る
      expect(await verifyAuditChain(db)).toEqual(okChain(4, 4));
      expect(await verifyAuditChain(db, 1000, { anchors: await readAuditAnchors(file), requireAnchors: true })).toMatchObject({
        ok: false,
        seq: 1,
        reason: expect.stringContaining("控え"),
      });
    } finally {
      rmSync(anchorDir, { recursive: true, force: true });
    }
  });
});

/** 前の版の形の行（鍵の無い SHA-256 の元） */
function legacyRow(seq: number) {
  return {
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
    prevHash: GENESIS_HASH,
  };
}
