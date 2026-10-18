import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    });
  });

  it("検像・読影・緊急は検査ごと、ブックマークは利用者ごと", async () => {
    const db = await dbs.fresh();
    await setStateFlag(db, "alice", STUDY, "inspected", true);
    await setStateFlag(db, "alice", STUDY, "urgent", true);
    await setStateFlag(db, "alice", STUDY, "bookmarked", true);
    expect((await readStates(db, "alice", [STUDY])).get(STUDY)).toMatchObject({ inspected: true, urgent: true, bookmarked: true, read: false });
    expect((await readStates(db, "bob", [STUDY])).get(STUDY)).toMatchObject({ inspected: true, urgent: true, bookmarked: false });
    await setStateFlag(db, "alice", STUDY, "bookmarked", true);
    await setStateFlag(db, "alice", STUDY, "bookmarked", false);
    await setStateFlag(db, "alice", STUDY, "inspected", false);
    expect((await readStates(db, "alice", [STUDY])).get(STUDY)).toMatchObject({ inspected: false, urgent: true, bookmarked: false });
  });

  it("一覧の状態の絞り込みに効く", async () => {
    const db = await dbs.fresh();
    await setStateFlag(db, "alice", STUDY, "urgent", true);
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

    await rememberViewer(db, "alice", STUDY, "volview");
    // 覚えはほかの利用者にも効く
    const other = (await listStudies({ ...deps, actorId: "bob" })).studies.find((s) => s.studyInstanceUid === STUDY)!;
    expect(other).toMatchObject({ defaultViewer: "volview", rememberedViewer: "volview" });

    await rememberViewer(db, "alice", STUDY, null);
    expect((await listStudies(deps)).studies.find((s) => s.studyInstanceUid === STUDY)!.defaultViewer).toBe("stone");
  });
});
