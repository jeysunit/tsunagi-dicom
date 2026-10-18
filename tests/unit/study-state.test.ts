import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendAuditWith, verifyAuditChain } from "@/lib/audit";
import { createMockBackend } from "@/lib/backend/mock";
import { listStudies } from "@/lib/study-list";
import { modalityDefaults, readStates, rememberViewer, setModalityDefault, setStateFlag } from "@/lib/study-state";
import { availableViewers } from "@/lib/viewers";
import { testDatabases } from "./helpers/test-db";

// 検査の状態（検像・読影・緊急・ブックマーク）とビューアの覚え（docs/spec.md の 3.1・3.2）。BFF のデータベースに持つ。

const dbs = testDatabases("tsunagi-state-");
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

describe("検査の状態", () => {
  it("覚えが無ければ、未検像・未読・緊急でない・ブックマークでない", async () => {
    const db = await dbs.fresh();
    expect((await readStates(db, "alice", [STUDY])).get(STUDY)).toEqual({
      inspected: false,
      read: false,
      urgent: false,
      bookmarked: false,
      rememberedViewer: null,
      stateVersion: 0,
    });
  });

  it("検像・読影・緊急は検査ごと、ブックマークは利用者ごと", async () => {
    const db = await dbs.fresh();
    expect(await setStateFlag(db, "alice", STUDY, "inspected", true, 0)).toEqual({ kind: "ok", version: 1 });
    expect(await setStateFlag(db, "alice", STUDY, "urgent", true, 1)).toEqual({ kind: "ok", version: 2 });
    // ブックマークは版を上げない
    expect(await setStateFlag(db, "alice", STUDY, "bookmarked", true, 2)).toEqual({ kind: "ok", version: 2 });
    expect((await readStates(db, "alice", [STUDY])).get(STUDY)).toMatchObject({ inspected: true, urgent: true, bookmarked: true, read: false });
    expect((await readStates(db, "bob", [STUDY])).get(STUDY)).toMatchObject({ inspected: true, urgent: true, bookmarked: false });
    await setStateFlag(db, "alice", STUDY, "bookmarked", true, 2);
    await setStateFlag(db, "alice", STUDY, "bookmarked", false, 2);
    await setStateFlag(db, "alice", STUDY, "inspected", false, 2);
    expect((await readStates(db, "alice", [STUDY])).get(STUDY)).toMatchObject({ inspected: false, urgent: true, bookmarked: false });
  });

  it("古い版からの変更は書かずに conflict（ほかの利用者が先に変えた値を上書きしない）", async () => {
    const db = await dbs.fresh();
    // alice と bob が、どちらも版 0 の画面を見ている
    expect(await setStateFlag(db, "alice", STUDY, "read", true, 0)).toEqual({ kind: "ok", version: 1 });
    expect(await setStateFlag(db, "bob", STUDY, "read", false, 0)).toEqual({ kind: "conflict", version: 1 });
    expect(await rememberViewer(db, "bob", STUDY, "stone", 0)).toEqual({ kind: "conflict", version: 1 });
    const state = (await readStates(db, "bob", [STUDY])).get(STUDY)!;
    expect(state).toMatchObject({ read: true, rememberedViewer: null, stateVersion: 1 });
    // 読み直した版なら通る
    expect(await setStateFlag(db, "bob", STUDY, "read", false, 1)).toEqual({ kind: "ok", version: 2 });
    // 先の版（まだ無い版）も断る
    expect(await setStateFlag(db, "bob", STUDY, "urgent", true, 5)).toEqual({ kind: "conflict", version: 2 });
  });

  it("初めての行を同時に作る2つの変更：片方だけが通り、もう片方は 500 にならずに conflict", async () => {
    const db = await dbs.fresh();
    const write = (actor: string, flag: "inspected" | "urgent") =>
      appendAuditWith(db, async (tx) => {
        const r = await setStateFlag(tx, actor, STUDY, flag, true, 0);
        return { value: r, input: { actorId: actor, actorRole: "technologist", authMode: "dev", action: "study_state", outcome: r.kind === "ok" ? "success" : "denied" } };
      });
    const results = await Promise.all([write("alice", "inspected"), write("bob", "urgent")]);
    expect(results.map((r) => r.value.kind).sort()).toEqual(["conflict", "ok"]);
    expect((await readStates(db, "x", [STUDY])).get(STUDY)!.stateVersion).toBe(1);
    expect(results.map((r) => r.row.outcome).sort()).toEqual(["denied", "success"]);
  });

  it("変更と監査の記録は1つの transaction：記録が書けなければ、変更も残らない", async () => {
    const db = await dbs.fresh();
    await expect(
      appendAuditWith(db, async (tx) => {
        await setStateFlag(tx, "alice", STUDY, "urgent", true, 0);
        // 記録の中身を文字にできない（JSON にできない値）＝記録の追記が失敗する
        return { value: null, input: { actorId: "alice", actorRole: "doctor", authMode: "dev", action: "study_state", detail: { bad: 1n } } };
      }),
    ).rejects.toThrow();
    expect(await db.studyState.count()).toBe(0);
    expect(await db.auditLog.count()).toBe(0);
    // 失敗の後も、記録のつなぎは続けて書ける
    await appendAuditWith(db, async (tx) => ({
      value: await setStateFlag(tx, "alice", STUDY, "urgent", true, 0),
      input: { actorId: "alice", actorRole: "doctor", authMode: "dev", action: "study_state" },
    }));
    expect(await db.studyState.count()).toBe(1);
    expect(await verifyAuditChain(db)).toEqual({ ok: true, checked: 1 });
  });

  it("一覧の状態の絞り込みに効く", async () => {
    const db = await dbs.fresh();
    await setStateFlag(db, "alice", STUDY, "urgent", true, 0);
    const deps = { backend: createMockBackend("orthanc"), db, role: "doctor" as const, actorId: "alice" };
    const urgent = await listStudies(deps, { date: "all", status: "urgent" });
    expect(urgent.studies.map((s) => s.studyInstanceUid)).toEqual([STUDY]);
    expect(urgent.returned).toHaveLength(1);
    expect((await listStudies(deps, { date: "all", status: "uninspected" })).studies).toHaveLength(8);
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
    const deps = { backend: createMockBackend("orthanc"), db, role: "doctor" as const, actorId: "alice", viewers: VIEWERS };
    const before = (await listStudies(deps)).studies.find((s) => s.studyInstanceUid === STUDY)!;
    expect(before).toMatchObject({ defaultViewer: "ohif", rememberedViewer: null });

    await setModalityDefault(db, "admin", "CT", "stone");
    expect((await listStudies(deps)).studies.find((s) => s.studyInstanceUid === STUDY)!.defaultViewer).toBe("stone");

    expect(await rememberViewer(db, "alice", STUDY, "volview", 0)).toEqual({ kind: "ok", version: 1 });
    // 覚えはほかの利用者にも効く
    const other = (await listStudies({ ...deps, actorId: "bob" })).studies.find((s) => s.studyInstanceUid === STUDY)!;
    expect(other).toMatchObject({ defaultViewer: "volview", rememberedViewer: "volview" });

    expect(other.stateVersion).toBe(1);
    await rememberViewer(db, "alice", STUDY, null, 1);
    expect((await listStudies(deps)).studies.find((s) => s.studyInstanceUid === STUDY)!.defaultViewer).toBe("stone");
  });
});
