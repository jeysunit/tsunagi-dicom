import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAuditWith, verifyAuditChain } from "@/lib/audit";
import { createMockBackend } from "@/lib/backend/mock";
import { listStudies } from "@/lib/study-list";
import { modalityDefaults, readViewerMemory, rememberViewer, setModalityDefault } from "@/lib/viewer-memory";
import { availableViewers } from "@/lib/viewers";
import { testDatabases } from "./helpers/test-db";

// ビューアの覚え（docs/spec.md の 3.2）。BFF のデータベースに持つ。
// 段 2 の検査の状態の試験（tests/unit/study-state.test.ts）のうち、ビューアの覚えの試験をここへ移した。
// 状態の印（検像・読影・緊急・ブックマーク）の試験は、機能ごと外した。

const dbs = testDatabases("tsunagi-viewer-");
beforeAll(() => dbs.setup(), 60_000);
afterAll(async () => {
  await dbs.closeAll();
  dbs.teardown();
});

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const VIEWERS = availableViewers({
  ohifUrl: "https://viewer.example.org/ohif",
  stoneUrl: "https://viewer.example.org/stone",
  volviewUrl: "https://viewer.example.org/volview",
  weasisEnabled: false,
});

describe("検査ごとのビューアの覚え", () => {
  it("覚えが無ければ、ビューアは null で版は 0", async () => {
    const db = await dbs.fresh();
    expect((await readViewerMemory(db, [STUDY])).get(STUDY)).toEqual({ rememberedViewer: null, viewerVersion: 0 });
  });

  it("古い版からの変更は書かずに conflict（ほかの利用者が先に変えた値を上書きしない）", async () => {
    const db = await dbs.fresh();
    // alice と bob が、どちらも版 0 の画面を見ている
    expect(await rememberViewer(db, "alice", STUDY, "volview", 0)).toEqual({ kind: "ok", version: 1 });
    expect(await rememberViewer(db, "bob", STUDY, "stone", 0)).toEqual({ kind: "conflict", version: 1 });
    expect((await readViewerMemory(db, [STUDY])).get(STUDY)).toEqual({ rememberedViewer: "volview", viewerVersion: 1 });
    // 読み直した版なら通る
    expect(await rememberViewer(db, "bob", STUDY, "stone", 1)).toEqual({ kind: "ok", version: 2 });
    // 先の版（まだ無い版）も断る
    expect(await rememberViewer(db, "bob", STUDY, null, 5)).toEqual({ kind: "conflict", version: 2 });
  });

  it("初めての行を同時に作る2つの変更：片方だけが通り、もう片方は 500 にならずに conflict", async () => {
    const db = await dbs.fresh();
    const write = (actor: string, viewer: "ohif" | "stone") =>
      appendAuditWith(db, async (tx) => {
        const r = await rememberViewer(tx, actor, STUDY, viewer, 0);
        return { value: r, input: { actorId: actor, actorRole: "technologist", authMode: "dev", action: "study_state", outcome: r.kind === "ok" ? "success" : "denied" } };
      });
    const results = await Promise.all([write("alice", "ohif"), write("bob", "stone")]);
    expect(results.map((r) => r.value.kind).sort()).toEqual(["conflict", "ok"]);
    expect((await readViewerMemory(db, [STUDY])).get(STUDY)!.viewerVersion).toBe(1);
    expect(results.map((r) => r.row.outcome).sort()).toEqual(["denied", "success"]);
  });

  it("変更と監査の記録は1つの transaction：記録が書けなければ、変更も残らない", async () => {
    const db = await dbs.fresh();
    await expect(
      appendAuditWith(db, async (tx) => {
        await rememberViewer(tx, "alice", STUDY, "ohif", 0);
        // 記録の中身を文字にできない（JSON にできない値）＝記録の追記が失敗する
        return { value: null, input: { actorId: "alice", actorRole: "doctor", authMode: "dev", action: "study_state", detail: { bad: 1n } } };
      }),
    ).rejects.toThrow();
    expect(await db.studyViewer.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
    // 失敗の後も、記録のつなぎは続けて書ける
    await appendAuditWith(db, async (tx) => ({
      value: await rememberViewer(tx, "alice", STUDY, "ohif", 0),
      input: { actorId: "alice", actorRole: "doctor", authMode: "dev", action: "study_state" },
    }));
    expect(await db.studyViewer.count()).toBe(1);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 1 });
  });
});

describe("ビューアの覚えと、モダリティの既定", () => {
  it("初めの既定は CT・MR が OHIF、CR・DX・US が Stone", async () => {
    const db = await dbs.fresh();
    const d = await modalityDefaults(db);
    expect([d.CT, d.MR, d["CR/DX"], d.US, d.MG]).toEqual(["ohif", "ohif", "stone", "stone", null]);
  });

  it("検査ごとの覚え → モダリティの既定の順に、既定のビューアを決める", async () => {
    const db = await dbs.fresh();
    const deps = { backend: createMockBackend(), db, role: "general" as const, actorId: "alice", viewers: VIEWERS };
    const before = (await listStudies(deps)).studies.find((s) => s.studyInstanceUid === STUDY)!;
    expect(before).toMatchObject({ defaultViewer: "ohif", rememberedViewer: null });

    await setModalityDefault(db, "admin", "CT", "stone");
    expect((await listStudies(deps)).studies.find((s) => s.studyInstanceUid === STUDY)!.defaultViewer).toBe("stone");

    expect(await rememberViewer(db, "alice", STUDY, "volview", 0)).toEqual({ kind: "ok", version: 1 });
    // 覚えはほかの利用者にも効く
    const other = (await listStudies({ ...deps, actorId: "bob" })).studies.find((s) => s.studyInstanceUid === STUDY)!;
    expect(other).toMatchObject({ defaultViewer: "volview", rememberedViewer: "volview" });

    expect(other.viewerVersion).toBe(1);
    await rememberViewer(db, "alice", STUDY, null, 1);
    expect((await listStudies(deps)).studies.find((s) => s.studyInstanceUid === STUDY)!.defaultViewer).toBe("stone");
  });
});

describe("段 3 の migration（状態の表を外し、ビューアの覚えを移す）", () => {
  const dir = path.resolve("prisma/migrations");
  const migrations = readdirSync(dir).filter((n) => /^\d{14}_/.test(n)).sort();
  const sql = (name: string) => readFileSync(path.join(dir, name, "migration.sql"), "utf8");
  const REMOVE = "20261020000000_remove_study_state";

  it("覚えの値と版は StudyViewer に移り、状態とブックマークの表は無くなる。監査の記録は残る", () => {
    const db = new DatabaseSync(":memory:");
    for (const name of migrations.filter((n) => n < REMOVE)) db.exec(sql(name));
    const now = "2026-10-19T00:00:00.000Z";
    db.prepare(
      'INSERT INTO "StudyState" ("studyInstanceUid","inspected","read","urgent","viewer","version","updatedBy","updatedAt") VALUES (?,?,?,?,?,?,?,?)',
    ).run("1.2.3", 1, 1, 0, "volview", 4, "alice", now);
    db.prepare(
      'INSERT INTO "StudyState" ("studyInstanceUid","inspected","read","urgent","viewer","version","updatedBy","updatedAt") VALUES (?,?,?,?,?,?,?,?)',
    ).run("1.2.4", 0, 0, 1, null, 2, "bob", now);
    db.prepare('INSERT INTO "StudyBookmark" ("actorId","studyInstanceUid","createdAt") VALUES (?,?,?)').run("alice", "1.2.3", now);

    db.exec(sql(REMOVE));

    const rows = db.prepare('SELECT "studyInstanceUid","viewer","version","updatedBy" FROM "StudyViewer" ORDER BY 1').all();
    expect(rows).toEqual([
      { studyInstanceUid: "1.2.3", viewer: "volview", version: 4, updatedBy: "alice" },
      { studyInstanceUid: "1.2.4", viewer: null, version: 2, updatedBy: "bob" },
    ]);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).not.toContain("StudyState");
    expect(tables).not.toContain("StudyBookmark");
    expect(tables).toContain("AuditLog");
    db.close();
  });
});
