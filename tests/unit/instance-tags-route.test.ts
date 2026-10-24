import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "@/lib/auth/roles";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 画像ごとの「主なタグ」の画面の API（GET /api/studies/{uid}/series/{series}/instances/{sop}/tags。docs/spec.md の 3.1）を、
// 本物の SQLite・本物のログイン（AUTH_MODE=local）・本物の役割の確かめで通して確かめる。
// 役割の割り当てだけを差し替え、一般から「すべての DICOM の値を見る」（dicom.all_values）を外して、断る形も見る。
// 設定（INSTANCE_TAGS）は試験ごとに替える。

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

vi.mock("@/lib/auth/roles", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/roles")>();
  const map = { ...real.ROLE_PERMISSIONS, general: real.ROLE_PERMISSIONS.general.filter((p) => p !== "dicom.all_values") };
  return {
    ...real,
    ROLE_PERMISSIONS: map,
    can: (role: Role, permission: (typeof real.PERMISSIONS)[number], m = map) => real.can(role, permission, m),
  };
});

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const dbs = testDatabases("tsunagi-instance-tags-");
let env: Record<string, string>;

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  env = {
    BACKEND_KIND: "orthanc",
    BACKEND_MOCK: "true",
    AUTH_MODE: "local",
    MFA_REQUIRED: "false",
    SESSION_SECRET: "t".repeat(48),
    DATABASE_URL: dbs.freshUrl(),
  };
  state.config = loadConfig(env);
}, 60_000);
afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  await (await getDb()).$disconnect();
  dbs.teardown();
});
beforeEach(async () => {
  state.token = undefined;
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig(env);
});

let users = 0;
async function loginAs(role: Role) {
  const { authContext } = await import("@/lib/auth/session");
  const { createUser, login } = await import("@/lib/auth/local-auth");
  const ctx = await authContext();
  const username = `tags-${role}-${(users += 1)}`;
  const password = "kq7vz2mw-long1";
  await createUser(ctx, { username, displayName: username, role, password, mustChangePassword: false }, { actorId: "system", actorRole: "none" });
  const result = await login(ctx, username, password);
  expect(result.stage).toBe("active");
  state.token = result.token;
}

async function lastAudit() {
  const { getDb } = await import("@/lib/db");
  return (await getDb()).auditLog.findFirst({ where: { action: "view_study" }, orderBy: { seq: "desc" } });
}

async function firstImages() {
  const { createMockBackend } = await import("@/lib/backend/mock");
  const backend = createMockBackend();
  const series = (await backend.searchSeries(STUDY))[0]!.seriesInstanceUid;
  return { series, instances: await backend.searchInstances(STUDY, series) };
}

async function tags(series: string, sop: string, study = STUDY) {
  const { GET } = await import("@/app/api/studies/[uid]/series/[series]/instances/[sop]/tags/route");
  return GET(new Request(`http://127.0.0.1/api/studies/${study}/series/${series}/instances/${sop}/tags`), {
    params: Promise.resolve({ uid: study, series, sop }),
  });
}

type Row = { tag: string; name: string; vr: string; value: string | null; length?: number };

describe("画像ごとの主なタグ", () => {
  it("既定の一覧：25 のタグを既定の順に、日本語のタグ名とともに返す。設定に無いタグは返さない。開いたことを記録する", async () => {
    await loginAs("admin");
    const { series, instances } = await firstImages();
    const res = await tags(series, instances[1]!.sopInstanceUid);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tags: Row[] };
    expect(Object.keys(body)).toEqual(["tags"]);
    expect(body.tags).toHaveLength(25);
    expect(body.tags[0]).toEqual({ tag: "0008,0018", name: "SOPインスタンスUID", vr: "UI", value: instances[1]!.sopInstanceUid });
    expect(body.tags.find((r) => r.tag === "0020,0013")).toEqual({ tag: "0020,0013", name: "画像番号", vr: "IS", value: "2" });
    // 患者の値（氏名・患者ID）は既定の一覧に無いので返らない
    expect(body.tags.some((r) => r.tag === "0010,0010" || r.tag === "0010,0020")).toBe(false);
    expect(JSON.stringify(body)).not.toContain("JP-TEST-0004");
    const row = await lastAudit();
    expect(row).toMatchObject({ outcome: "success", actorRole: "admin", studyInstanceUid: STUDY, patientId: "JP-TEST-0004" });
    expect(JSON.parse(row!.detail!)).toMatchObject({
      allValues: true,
      level: "instance",
      set: "configured",
      seriesInstanceUid: series,
      sopInstanceUid: instances[1]!.sopInstanceUid,
    });
  });

  it("INSTANCE_TAGS のとおり、書いた順に返す。画像に無いタグも行を返し、値は null", async () => {
    const { loadConfig } = await import("@/lib/config");
    state.config = loadConfig({ ...env, INSTANCE_TAGS: "(0020,0013) (0008,0018) 0010,0010 00180050" });
    await loginAs("admin");
    const { series, instances } = await firstImages();
    const { tags: rows } = (await (await tags(series, instances[0]!.sopInstanceUid)).json()) as { tags: Row[] };
    expect(rows.map((r) => r.tag)).toEqual(["0020,0013", "0008,0018", "0010,0010", "0018,0050"]);
    expect(rows[2]).toEqual({ tag: "0010,0010", name: "氏名", vr: "PN", value: "Shiken^Takako=試験^髙子=しけん^たかこ" });
    expect(rows[3]).toEqual({ tag: "0018,0050", name: "スライス厚", vr: "", value: null });
  });

  it("dicom.all_values の無い役割は 403。値は返らず、断ったことが記録に残る", async () => {
    await loginAs("general");
    const { series, instances } = await firstImages();
    const res = await tags(series, instances[0]!.sopInstanceUid);
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain(instances[0]!.sopInstanceUid);
    const row = await lastAudit();
    expect(row).toMatchObject({ outcome: "denied", actorRole: "general", studyInstanceUid: STUDY });
    expect(JSON.parse(row!.detail!)).toMatchObject({ reason: "forbidden", permission: "dicom.all_values", set: "configured" });
  });

  it("ログインしていなければ 401", async () => {
    const { series, instances } = await firstImages();
    expect((await tags(series, instances[0]!.sopInstanceUid)).status).toBe(401);
  });

  it("UID の形が誤りなら 400、見つからない画像・ほかのシリーズの下の画像は 404", async () => {
    await loginAs("admin");
    const { series, instances } = await firstImages();
    expect((await tags("../x", "1.2")).status).toBe(400);
    expect((await tags(series, "1.2;x")).status).toBe(400);
    expect((await tags(series, "1.2.3")).status).toBe(404);
    expect((await tags("1.2.3", instances[0]!.sopInstanceUid)).status).toBe(404);
  });

  it("値の全部（…/values）の記録には set: all が入る", async () => {
    await loginAs("admin");
    const { series, instances } = await firstImages();
    const { GET } = await import("@/app/api/studies/[uid]/series/[series]/instances/[sop]/values/route");
    const sop = instances[0]!.sopInstanceUid;
    const res = await GET(new Request("http://127.0.0.1/x"), { params: Promise.resolve({ uid: STUDY, series, sop }) });
    expect(res.status).toBe(200);
    expect(JSON.parse((await lastAudit())!.detail!)).toMatchObject({ level: "instance", set: "all", sopInstanceUid: sop });
  });
});
