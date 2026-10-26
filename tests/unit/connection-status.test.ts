import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 上の帯の接続の状態（GET /api/connection-status。docs/spec.md の 3.3）を、検証モード（AUTH_MODE=dev。モックの Orthanc）の
// セッションから通して確かめる。役割ごとに返す項目（許可の一覧の connection・modality）、載っていない項目は返らないこと、
// 権限の無い要求を断って記録すること、直近の接続確認の結果を反映すること、画像サーバーが読めないときの全体の状態を見る。

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

const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-connection-status-");

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig({
    BACKEND_MOCK: "true",
    AUTH_MODE: "dev",
    DEV_ALLOW_WRITE: "true",
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
  vi.restoreAllMocks();
});

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
function post(path: string) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, host: new URL(ORIGIN).host },
    body: "{}",
  });
}
async function db() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}
async function connection() {
  const { GET } = await import("@/app/api/connection-status/route");
  const res = await GET();
  return { status: res.status, body: await res.json() };
}

describe("接続の状態の API", () => {
  it("一般には、全体の状態・画像サーバー・HL7 の受け口・接続先の名前と AE タイトルだけを返す（住所は返さない）", async () => {
    state.role = "general";
    const { status, body } = await connection();
    expect(status).toBe(200);
    expect(Object.keys(body.connection).sort()).toEqual(["hl7", "mock", "modalities", "orthanc", "overall"]);
    expect(body.connection).toMatchObject({ orthanc: "ok", hl7: "off", mock: true });
    expect(body.connection.modalities.map((m: { id: string }) => m.id)).toEqual(["dtg", "offline", "workstation"]);
    for (const m of body.connection.modalities) expect(Object.keys(m).sort()).toEqual(["aet", "at", "id", "result"]);
    // 住所・製造元・機器ごとの許可は、接続の状態にも出さない
    expect(JSON.stringify(body)).not.toMatch(/192\.0\.2\.|host|port|manufacturer|allowEcho|allowStore/);
  });

  it("管理者にも、住所は返さない（接続の状態の項目に無い）", async () => {
    state.role = "admin";
    const { body } = await connection();
    for (const m of body.connection.modalities) expect(Object.keys(m).sort()).toEqual(["aet", "at", "id", "result"]);
  });

  it("接続確認の結果が直近のものとして反映される：失敗した接続先があれば全体は ng、確かめ直して成功すれば戻る", async () => {
    state.role = "general";
    const { POST } = await import("@/app/api/modalities/[id]/echo/route");
    expect((await (await POST(post("/api/modalities/offline/echo"), idParams("offline"))).json()).connected).toBe(false);
    let { body } = await connection();
    expect(body.connection.overall).toBe("ng");
    const offline = body.connection.modalities.find((m: { id: string }) => m.id === "offline");
    expect(offline).toMatchObject({ result: "ng" });
    expect(typeof offline.at).toBe("string");
    // 確かめていない接続先は、結果も時刻も持たない
    expect(body.connection.modalities.find((m: { id: string }) => m.id === "workstation")).toMatchObject({ result: null, at: null });

    // 失敗した接続先を、機器の側が直ったあとの成功で置き換える（モックでは offline は常に失敗するので、監査の記録に成功を足して確かめる）
    const { appendAudit } = await import("@/lib/audit");
    await appendAudit(await db(), {
      actorId: "t",
      actorRole: "general",
      authMode: "dev",
      action: "echo",
      outcome: "success",
      detail: { modality: "offline", connected: true },
    });
    ({ body } = await connection());
    expect(body.connection.modalities.find((m: { id: string }) => m.id === "offline")).toMatchObject({ result: "ok" });
    expect(body.connection.overall).toBe("ok");
  });

  it("ほかの接続先の確認が何度続いても、失敗した接続先の直近の結果は消えない", async () => {
    state.role = "general";
    const { POST } = await import("@/app/api/modalities/[id]/echo/route");
    expect((await (await POST(post("/api/modalities/offline/echo"), idParams("offline"))).json()).connected).toBe(false);
    const { appendAudit } = await import("@/lib/audit");
    for (let i = 0; i < 40; i++) {
      await appendAudit(await db(), {
        actorId: "t",
        actorRole: "general",
        authMode: "dev",
        action: "echo",
        outcome: "success",
        detail: { modality: "dtg", connected: true },
      });
    }
    const { body } = await connection();
    expect(body.connection.modalities.find((m: { id: string }) => m.id === "offline")).toMatchObject({ result: "ng" });
    expect(body.connection.modalities.find((m: { id: string }) => m.id === "dtg")).toMatchObject({ result: "ok" });
    expect(body.connection.overall).toBe("ng");
  });

  it("権限の無い役割には 403 を返し、断ったことを記録する", async () => {
    const { ROLE_PERMISSIONS } = await import("@/lib/auth/roles");
    const original = ROLE_PERMISSIONS.general;
    ROLE_PERMISSIONS.general = original.filter((p) => p !== "connection.view");
    try {
      state.role = "general";
      const { status, body } = await connection();
      expect(status).toBe(403);
      expect(JSON.stringify(body)).not.toContain("modalities");
      const row = await (await db()).auditLog.findFirst({ where: { action: "echo", outcome: "denied" }, orderBy: { seq: "desc" } });
      expect(JSON.parse(row?.detail ?? "{}")).toMatchObject({ via: "connection-status", permission: "connection.view" });
    } finally {
      ROLE_PERMISSIONS.general = original;
    }
  });
});

describe("接続の状態の組み立て", () => {
  it("画像サーバーが読めないときは、画像サーバーも全体も ng（接続先は出さない）", async () => {
    const { connectionRecord } = await import("@/lib/connection-status");
    const record = await connectionRecord({
      backend: { mock: false, listModalities: async () => Promise.reject(new Error("down")) },
      db: await db(),
      hl7Configured: true,
    });
    expect(record).toMatchObject({ overall: "ng", orthanc: "ng", hl7: "listen", modalities: [], mock: false });
  });

  it("許可の一覧に載っていない項目は返らない。一覧に無ければ何も返らない", async () => {
    const { connectionRecord, connectionView } = await import("@/lib/connection-status");
    const record = await connectionRecord({
      backend: { mock: true, listModalities: async () => [{ id: "unchecked", aet: "UNCHECKED_SCP", host: "192.0.2.20", port: 104, manufacturer: "", allowEcho: true, allowStore: true }] },
      db: await db(),
      hl7Configured: false,
    });
    expect(connectionView(record, { study: [], series: [], connection: ["overall"] })).toEqual({ overall: record.overall });
    expect(connectionView(record, { study: [], series: [] })).toEqual({});
    // 接続先は、名前（id）を見せてよい役割にだけ。AE タイトルはさらに aet が載っているときだけ
    expect(connectionView(record, { study: [], series: [], connection: ["modalities"] })).toEqual({});
    expect(connectionView(record, { study: [], series: [], connection: ["modalities"], modality: ["id"] }).modalities).toEqual([
      { id: "unchecked", result: null, at: null },
    ]);
  });
});
