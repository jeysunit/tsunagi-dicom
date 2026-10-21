import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { appendAudit } from "@/lib/audit";
import { resetAuditAnchorState, writeAuditAnchor } from "@/lib/audit-anchor";
import type { Db } from "@/lib/db";
import { testDatabases } from "./helpers/test-db";

// /api/audit/verify（src/app/api/audit/verify/route.ts）：先頭の控えと照らせないときは、つなぎの中に食い違いが無くても
// ok にしない（docs/adr/0001-audit-chain-mac.md）。管理者の確かめ（requireSession）・設定・データベースだけを差し替える。

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  config: {
    sessionSecret: "tsunagi-dicom-audit-route-test-secret-0123456789",
    audit: { anchorFile: undefined as string | undefined, sessionSecretPrevious: [] as string[] },
  },
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => state.config as never };
});
vi.mock("@/lib/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/db")>();
  return { ...real, getDb: async () => state.db };
});
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...real, requireSession: async () => ({ actorId: "admin", role: "admin" }) };
});

const dbs = testDatabases("tsunagi-verify-route-");
let dir: string;
beforeAll(() => {
  dbs.setup();
  dir = mkdtempSync(path.join(tmpdir(), "tsunagi-verify-route-anchors-"));
});
afterAll(() => {
  dbs.teardown();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(async () => {
  await dbs.closeAll();
});

let n = 0;
async function setUp(rows: number, anchorFile: string | undefined): Promise<Db> {
  resetAuditAnchorState();
  const db = await dbs.fresh();
  state.db = db;
  state.config.audit.anchorFile = anchorFile;
  for (let i = 0; i < rows; i++) await appendAudit(db, { actorId: "dev", actorRole: "admin", authMode: "local", action: "search" });
  return db;
}

async function verify() {
  const { GET } = await import("@/app/api/audit/verify/route");
  const res = await GET();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("/api/audit/verify：先頭の控えと照らせないときは ok にしない", () => {
  beforeEach(() => {
    n += 1;
  });

  it("控えのファイルを設定していなければ、つなぎが正しくても 409（照らしていないことが分かる）", async () => {
    await setUp(3, undefined);
    const { status, body } = await verify();
    expect(status).toBe(409);
    expect(body).toMatchObject({ ok: false, checked: 3, anchors: { status: "not-configured" } });
    expect(body.reason).toContain("AUDIT_ANCHOR_FILE を設定していない");
  });

  it("行がまだ無ければ、控えが無くても 200（no-rows）", async () => {
    await setUp(0, undefined);
    expect(await verify()).toMatchObject({ status: 200, body: { ok: true, anchors: { status: "no-rows" } } });
    await setUp(0, path.join(dir, `none${n}.jsonl`));
    expect(await verify()).toMatchObject({ status: 200, body: { ok: true, anchors: { status: "no-rows" } } });
  });

  it("控えと照らして合えば 200（checked）。控えのファイルが無い・壊れていれば 409", async () => {
    const file = path.join(dir, `a${n}.jsonl`);
    const db = await setUp(3, file);
    // 記録のある一式で控えを始める（施設が空のファイルを置く）
    writeFileSync(file, "");
    await writeAuditAnchor(db, file, () => undefined);
    expect(await verify()).toMatchObject({ status: 200, body: { ok: true, anchors: { status: "checked", checked: 1 } } });

    rmSync(file);
    expect(await verify()).toMatchObject({ status: 409, body: { ok: false, reason: expect.stringContaining("先頭の控えが無い") } });

    writeFileSync(file, "not json\n");
    expect(await verify()).toMatchObject({ status: 409, body: { ok: false, reason: expect.stringContaining("読めない") } });
  });

  it("利用者がいるのに記録が1行も無ければ 409（記録と控えのファイルを一緒に消されたとき・控えを設定していないとき、初めての起動と見分ける）", async () => {
    for (const anchorFile of [path.join(dir, `gone${n}.jsonl`), undefined]) {
      const db = await setUp(0, anchorFile);
      await db.user.create({
        data: {
          id: "u1",
          username: "admin1",
          displayName: "管理者",
          role: "admin",
          passwordHash: "x",
          passwordChangedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      expect(await verify(), String(anchorFile)).toMatchObject({ status: 409, body: { ok: false, reason: expect.stringContaining("利用者がいるのに") } });
    }
  });

  it("利用者がいるのに記録も控えも無ければ、起き直しても控えのファイルを作らない（記録が増えた後も）", async () => {
    const file = path.join(dir, `restart${n}.jsonl`);
    const db = await setUp(0, file);
    await db.user.create({
      data: {
        id: "u1",
        username: "admin1",
        displayName: "管理者",
        role: "admin",
        passwordHash: "x",
        passwordChangedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    // 起き直しの控えの書き出し：作らず、作らなかったことを記録に残す
    await expect(writeAuditAnchor(db, file, () => undefined)).rejects.toThrow("作らない");
    expect(await db.auditLog.findFirst({ where: { action: "audit_anchor" } })).toMatchObject({ outcome: "denied" });
    // 記録が増えた後の書き出しでも作らない。確かめは控えと照らせないので 409
    await appendAudit(db, { actorId: "admin1", actorRole: "admin", authMode: "local", action: "login" });
    await expect(writeAuditAnchor(db, file, () => undefined)).rejects.toThrow("作り直さない");
    expect(await verify()).toMatchObject({ status: 409, body: { ok: false, reason: expect.stringContaining("先頭の控えが無い") } });
  });
});
