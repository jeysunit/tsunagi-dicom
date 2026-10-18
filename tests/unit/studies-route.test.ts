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
  const map = { ...real.ROLE_FIELD_ALLOWLIST, viewer: { study: ["studyInstanceUid", "studyDate"] as const } };
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
  const res = await GET();
  return { status: res.status, body: (await res.json()) as { studies: Record<string, unknown>[] } };
}

describe("検査の一覧の画面の API と、役割の許可の一覧", () => {
  it("許可の一覧を狭めた役割（閲覧）には、載っていない項目が返らない", async () => {
    state.role = "viewer";
    const { status, body } = await getStudies();
    expect(status).toBe(200);
    expect(body.studies).toHaveLength(8);
    for (const s of body.studies) expect(Object.keys(s).sort()).toEqual(["studyDate", "studyInstanceUid"]);
    const text = JSON.stringify(body);
    for (const leaked of ["JP-TEST-", "山田", "やまだ", "Yamada", "ACC-"]) expect(text).not.toContain(leaked);
  });

  it("ほかの役割の見え方は変わらない", async () => {
    state.role = "doctor";
    const { status, body } = await getStudies();
    expect(status).toBe(200);
    expect(body.studies[0]).toHaveProperty("patientName");
    expect(JSON.stringify(body)).toContain("JP-TEST-");
  });

  it("返した検査を監査の記録に残す（絞った役割でも、記録には患者 ID と検査の組を残す）", async () => {
    state.role = "viewer";
    await getStudies();
    const { getDb } = await import("@/lib/db");
    const row = await (await getDb()).auditLog.findFirst({ where: { action: "search" }, orderBy: { seq: "desc" } });
    expect(row?.actorRole).toBe("viewer");
    expect(JSON.parse(row!.detail!).returned).toHaveLength(8);
  });
});
