import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/roles";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 中継の route handler（src/app/api/dicom-web/[...path]/route.ts）を、セッションの cookie から通して確かめる。
// 本物の SQLite・本物のログイン（AUTH_MODE=local）・本物の役割の確かめを使い、役割の割り当てだけを差し替えて、
// 画像の取得（image.retrieve）が割り当てられていない役割では、中継が 403 を返し、断ったことが記録に残ることを見る。
// Next.js の外なので、next/headers（cookie・ヘッダー）と、設定（getConfig）だけを差し替える。

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  config: undefined as AppConfig | undefined,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "__Host-tsunagi_session" && state.token ? { name, value: state.token } : undefined),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
}));

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => state.config! };
});

// 閲覧（viewer）から画像の取得を外した割り当て（「割り当ての無い役割」を作る）
vi.mock("@/lib/auth/roles", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/roles")>();
  const map = { ...real.ROLE_PERMISSIONS, viewer: real.ROLE_PERMISSIONS.viewer.filter((p) => p !== "image.retrieve") };
  return {
    ...real,
    ROLE_PERMISSIONS: map,
    can: (role: Role, permission: (typeof real.PERMISSIONS)[number], m = map) => real.can(role, permission, m),
  };
});

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const dbs = testDatabases("tsunagi-route-");

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig({
    BACKEND_KIND: "orthanc",
    BACKEND_MOCK: "true",
    AUTH_MODE: "local",
    MFA_REQUIRED: "false",
    SESSION_SECRET: "r".repeat(48),
    DATABASE_URL: dbs.freshUrl(),
  });
}, 60_000);
afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  await (await getDb()).$disconnect();
  dbs.teardown();
});
beforeEach(() => {
  state.token = undefined;
});

async function loginAs(username: string, role: Role) {
  const { authContext } = await import("@/lib/auth/session");
  const { createUser, login } = await import("@/lib/auth/local-auth");
  const ctx = await authContext();
  const password = "kq7vz2mw-long1";
  await createUser(ctx, { username, displayName: username, role, password, mustChangePassword: false }, { actorId: "system", actorRole: "none" });
  const result = await login(ctx, username, password);
  expect(result.stage).toBe("active");
  state.token = result.token;
}

async function relay(segments: string[]) {
  const { GET } = await import("@/app/api/dicom-web/[...path]/route");
  return GET(new Request(`http://127.0.0.1/api/dicom-web/${segments.join("/")}`), {
    params: Promise.resolve({ path: segments }),
  });
}

describe("中継の route handler の役割の確かめ", () => {
  it("ログインしていなければ 401", async () => {
    expect((await relay(["studies", STUDY, "metadata"])).status).toBe(401);
  });

  it("画像の取得が割り当てられていない役割では、中継は 403 を返し、断ったことを記録する", async () => {
    await loginAs("viewer1", "viewer");
    const res = await relay(["studies", STUDY, "metadata"]);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("この役割では画像を取れない");

    const { getDb } = await import("@/lib/db");
    const rows = await (await getDb()).auditLog.findMany({ where: { action: "retrieve" }, orderBy: { seq: "asc" } });
    expect(rows.at(-1)).toMatchObject({ actorId: "viewer1", actorRole: "viewer", outcome: "denied" });
    expect(rows.at(-1)!.detail).toContain('"reason":"forbidden"');
  });

  it("割り当てられている役割は、同じ道で画像サーバー（モック）まで届く", async () => {
    await loginAs("doctor1", "doctor");
    const res = await relay(["studies", STUDY, "metadata"]);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(401);
  });
});
