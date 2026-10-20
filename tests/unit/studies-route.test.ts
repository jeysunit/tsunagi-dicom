import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 検査の一覧の画面の API（src/app/api/studies/route.ts）を、検証モード（AUTH_MODE=dev）のセッションから通して確かめる。
// 閲覧の役割の許可の一覧だけを狭め、載っていない項目が返らず、ほかの役割の見え方が変わらないことを見る（原則 8）。

const state = vi.hoisted(() => ({
  role: undefined as string | undefined,
  config: undefined as AppConfig | undefined,
}));

vi.mock("next/headers", async () => {
  const { encodeDevRole } = await import("@/lib/auth/dev-role-cookie");
  return {
    cookies: async () => ({
      get: (name: string) =>
        name === "tsunagi_dev_role" && state.role
          ? { name, value: encodeDevRole(state.role as never, state.config!.sessionSecret) }
          : undefined,
      set: () => undefined,
    }),
    headers: async () => new Headers(),
  };
});

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => state.config! };
});

vi.mock("@/lib/fields", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/fields")>();
  // 一般だけを狭める（2026-10-20 に役割を2つにしたので、前の「閲覧を狭め、医師で既定を見る」形を「一般を狭め、管理者で既定を見る」形にした）
  const map = { ...real.ROLE_FIELD_ALLOWLIST, general: { study: ["studyInstanceUid", "studyDate"] as const, series: ["seriesInstanceUid"] as const } };
  return { ...real, ROLE_FIELD_ALLOWLIST: map, allowlistFor: (role: never, m = map) => real.allowlistFor(role, m) };
});

const dbs = testDatabases("tsunagi-studies-route-");

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig({
    BACKEND_KIND: "orthanc",
    BACKEND_MOCK: "true",
    AUTH_MODE: "dev",
    SESSION_SECRET: "s".repeat(48),
    DATABASE_URL: dbs.freshUrl(),
  });
}, 60_000);
afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  await (await getDb()).$disconnect();
  dbs.teardown();
});
beforeEach(() => {
  state.role = undefined;
});

async function getStudies() {
  const { GET } = await import("@/app/api/studies/route");
  const res = await GET(new Request("http://127.0.0.1/api/studies"));
  return { status: res.status, body: (await res.json()) as { studies: Record<string, unknown>[]; facets: Record<string, Record<string, number>> } };
}

describe("検査の一覧の画面の API と、役割の許可の一覧", () => {
  it("許可の一覧を狭めた役割（閲覧）には、載っていない項目が返らない", async () => {
    state.role = "general";
    const { status, body } = await getStudies();
    expect(status).toBe(200);
    expect(body.studies).toHaveLength(8);
    for (const s of body.studies) expect(Object.keys(s).sort()).toEqual(["studyDate", "studyInstanceUid"]);
    const text = JSON.stringify(body);
    for (const leaked of ["JP-TEST-", "山田", "やまだ", "Yamada", "ACC-"]) expect(text).not.toContain(leaked);
  });

  it("見出しの件数は、許可の一覧に載っていない項目の分を返さない（閲覧は検査日の件数だけ）", async () => {
    state.role = "general";
    const { body } = await getStudies();
    expect(Object.keys(body.facets)).toEqual(["date"]);
    expect(body.facets.date).toMatchObject({ all: 8 });
    expect(JSON.stringify(body.facets)).not.toMatch(/CT|MR|unread|inspected/);
  });

  it("ほかの役割には、検査日・モダリティの件数がある（状態の件数は段 3 で外した）", async () => {
    state.role = "admin";
    const { body } = await getStudies();
    expect(Object.keys(body.facets).sort()).toEqual(["date", "modality"]);
    expect(body.facets.date!.all).toBe(8);
    expect(body.facets.modality).toMatchObject({ all: 8, CT: 6, MR: 2 });
  });

  it("ほかの役割の見え方は変わらない", async () => {
    state.role = "admin";
    const { status, body } = await getStudies();
    expect(status).toBe(200);
    expect(body.studies[0]).toHaveProperty("patientName");
    expect(JSON.stringify(body)).toContain("JP-TEST-");
  });

  it("返した検査を監査の記録に残す（絞った役割でも、記録には患者 ID と検査の組を残す）", async () => {
    state.role = "general";
    await getStudies();
    const { getDb } = await import("@/lib/db");
    const row = await (await getDb()).auditLog.findFirst({ where: { action: "search" }, orderBy: { seq: "desc" } });
    expect(row?.actorRole).toBe("general");
    expect(JSON.parse(row!.detail!).returned).toHaveLength(8);
  });

  it("自動更新の名乗り（refresh=auto）：監査の行は手動と同じに全部残し、直前の手動の検索と同じ条件のときだけ trigger: auto を申告の値として残す", async () => {
    state.role = "general";
    const { GET } = await import("@/app/api/studies/route");
    const { forgetManualSearches } = await import("@/lib/search-trigger");
    const { getDb } = await import("@/lib/db");
    const lastRow = async () => (await (await getDb()).auditLog.findFirst({ where: { action: "search" }, orderBy: { seq: "desc" } }))!;
    const get = async (qs: string) => {
      const res = await GET(new Request(`http://127.0.0.1/api/studies${qs}`));
      expect(res.status).toBe(200);
      const row = await lastRow();
      return { row, detail: JSON.parse(row.detail!) as Record<string, unknown> };
    };
    forgetManualSearches();

    // 手動の検索の前の名乗りは、手動として扱う（監査は薄めない）
    const first = await get("?refresh=auto");
    expect(first.detail).not.toHaveProperty("trigger");
    expect(first.detail.returned).toHaveLength(8);

    // 手動の検索のあと、同じ条件の名乗りは auto と残す。行の中身（返した検査の組・件数）と項目は手動と同じ
    const manual = await get("");
    const auto = await get("?refresh=auto");
    expect(auto.detail).toMatchObject({ via: "api", trigger: "auto" });
    expect(auto.detail.returned).toEqual(manual.detail.returned);
    expect(auto.detail.results).toBe(manual.detail.results);
    expect(Object.keys(auto.detail).filter((k) => k !== "trigger").sort()).toEqual(Object.keys(manual.detail).sort());
    expect({ outcome: auto.row.outcome, actorRole: auto.row.actorRole }).toEqual({ outcome: manual.row.outcome, actorRole: manual.row.actorRole });

    // 条件が直前の手動の検索と違う名乗りは、手動として扱う（自動の読み直しは、同じ条件の読み直しに限る）
    const other = await get("?modality=CT&refresh=auto");
    expect(other.detail).not.toHaveProperty("trigger");
    expect(Array.isArray(other.detail.returned)).toBe(true);
    // その検索が、次の「直前の手動の検索」になる
    expect((await get("?modality=CT&refresh=auto")).detail).toMatchObject({ trigger: "auto" });
    expect((await get("?refresh=auto")).detail).not.toHaveProperty("trigger");
    // auto でない名乗りは無視する
    expect((await get("?refresh=manual")).detail).not.toHaveProperty("trigger");
  });
});
