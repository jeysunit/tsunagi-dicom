import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_THEME, getTheme, isTheme, setTheme } from "@/lib/preferences";
import { testDatabases } from "./helpers/test-db";

// 利用者ごとの地の色（docs/spec.md の 2）。明るい地を既定にし、選んだ地を利用者ごとに覚える。

const dbs = testDatabases("tsunagi-pref-");
beforeAll(() => dbs.setup(), 60_000);
afterAll(async () => {
  await dbs.closeAll();
  dbs.teardown();
});

describe("地の色", () => {
  it("覚えが無ければ明るい地", async () => {
    const db = await dbs.fresh();
    expect(DEFAULT_THEME).toBe("light");
    expect(await getTheme(db, "someone")).toBe("light");
  });

  it("利用者ごとに覚え、ほかの利用者には効かない", async () => {
    const db = await dbs.fresh();
    await setTheme(db, "alice", "dark");
    expect(await getTheme(db, "alice")).toBe("dark");
    expect(await getTheme(db, "bob")).toBe("light");
    await setTheme(db, "alice", "light");
    expect(await getTheme(db, "alice")).toBe("light");
  });

  it("読めない値は既定にする", async () => {
    const db = await dbs.fresh();
    await db.userPreference.create({ data: { actorId: "carol", theme: "neon", updatedAt: new Date() } });
    expect(await getTheme(db, "carol")).toBe("light");
    expect([isTheme("dark"), isTheme("light"), isTheme("Dark"), isTheme(1)]).toEqual([true, true, false, false]);
  });
});
