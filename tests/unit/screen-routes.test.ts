import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 段 2 の画面の API（検査の詳細・すべての値・状態・ビューアの覚え・ビューアで開く・モダリティの既定）を、
// 検証モード（AUTH_MODE=dev）のセッションから通して確かめる。役割ごとの操作の権限・許可の一覧・監査の記録を見る。

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

// 閲覧の役割だけ、シリーズの項目を SeriesInstanceUID だけに狭める（ほかの役割は既定）
vi.mock("@/lib/fields", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/fields")>();
  const map = { ...real.ROLE_FIELD_ALLOWLIST, viewer: { study: ["studyInstanceUid"] as const, series: ["seriesInstanceUid"] as const } };
  return { ...real, ROLE_FIELD_ALLOWLIST: map, allowlistFor: (role: never, m = map) => real.allowlistFor(role, m) };
});

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-screen-routes-");

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig({
    BACKEND_KIND: "orthanc",
    BACKEND_MOCK: "true",
    AUTH_MODE: "dev",
    SESSION_SECRET: "s".repeat(48),
    DATABASE_URL: dbs.freshUrl(),
    VIEWER_OHIF_URL: "https://viewer.example.org/ohif",
    VIEWER_STONE_URL: "https://viewer.example.org/stone",
    PUBLIC_DICOMWEB_URL: "https://pacs.example.org/dicom-web",
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

const params = (uid: string) => ({ params: Promise.resolve({ uid }) });
function post(path: string, body: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(ORIGIN).host },
    body: JSON.stringify(body),
  });
}
async function lastAudit(action: string) {
  const { getDb } = await import("@/lib/db");
  return (await getDb()).auditLog.findFirst({ where: { action }, orderBy: { seq: "desc" } });
}

describe("検査の詳細", () => {
  it("検査・患者の情報とシリーズを返し、詳細を開いたことを記録する", async () => {
    state.role = "doctor";
    const { GET } = await import("@/app/api/studies/[uid]/route");
    const res = await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.study).toMatchObject({ studyInstanceUid: STUDY, patientId: "JP-TEST-0004", patientName: "試験 髙子", referringPhysicianName: "試験 医師" });
    expect(body.series).toHaveLength(1);
    expect(body.series[0]).toMatchObject({ modality: "CT", seriesNumber: "1", instanceCount: 4 });
    // 画像サーバーの取得の URL・施設などの値は返さない
    expect(JSON.stringify(body)).not.toContain("pacs.example.org");
    const row = await lastAudit("view_study");
    expect(row).toMatchObject({ actorRole: "doctor", studyInstanceUid: STUDY, patientId: "JP-TEST-0004" });
  });

  it("許可の一覧を狭めた役割には、載っていない検査・シリーズの項目が返らない", async () => {
    state.role = "viewer";
    const { GET } = await import("@/app/api/studies/[uid]/route");
    const body = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY))).json();
    expect(Object.keys(body.study)).toEqual(["studyInstanceUid"]);
    for (const s of body.series) expect(Object.keys(s)).toEqual(["seriesInstanceUid"]);
    expect(JSON.stringify(body)).not.toMatch(/JP-TEST-|髙子|Chest/);
  });

  it("UID の形が誤りなら 400、見つからなければ 404", async () => {
    state.role = "doctor";
    const { GET } = await import("@/app/api/studies/[uid]/route");
    expect((await GET(new Request(`${ORIGIN}/api/studies/x`), params("../x"))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/api/studies/1.2.3`), params("1.2.3"))).status).toBe(404);
  });
});

/** いまの状態の版（画面が読んだ時の版の代わり） */
async function currentVersion() {
  const { getDb } = await import("@/lib/db");
  return (await (await getDb()).studyState.findUnique({ where: { studyInstanceUid: STUDY } }))?.version ?? 0;
}

describe("すべての DICOM の値（別の権限）", () => {
  it.each([
    ["admin", 200],
    ["technologist", 200],
    ["doctor", 403],
    ["viewer", 403],
  ] as const)("%s は %s（断ったものも記録する）", async (role, status) => {
    state.role = role;
    const { GET } = await import("@/app/api/studies/[uid]/values/route");
    const res = await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/values`), params(STUDY));
    expect(res.status).toBe(status);
    if (status === 200) {
      const { values } = await res.json();
      expect(values).toContainEqual({ tag: "0010,0010", vr: "PN", value: "Shiken^Takako=試験^髙子=しけん^たかこ" });
    } else {
      const row = await lastAudit("view_study");
      expect(row).toMatchObject({ outcome: "denied", actorRole: role, studyInstanceUid: STUDY });
      expect(JSON.parse(row!.detail!)).toMatchObject({ allValues: true, reason: "forbidden", permission: "dicom.all_values" });
    }
  });
});

describe("検査の状態の変更", () => {
  it("閲覧は検像できない（403 と、断ったことの記録。状態は変わらない）", async () => {
    state.role = "viewer";
    const { POST } = await import("@/app/api/studies/[uid]/state/route");
    const res = await POST(post(`/api/studies/${STUDY}/state`, { flag: "inspected", value: true, version: 0 }), params(STUDY));
    expect(res.status).toBe(403);
    expect(await lastAudit("study_state")).toMatchObject({ outcome: "denied", actorRole: "viewer" });
    expect(await currentVersion()).toBe(0);
  });

  it("技師は検像でき、医師は既読にでき、閲覧はブックマークだけできる", async () => {
    const { POST } = await import("@/app/api/studies/[uid]/state/route");
    for (const [role, flag, status] of [
      ["technologist", "inspected", 200],
      ["technologist", "read", 403],
      ["doctor", "read", 200],
      ["doctor", "inspected", 403],
      ["viewer", "bookmarked", 200],
      ["viewer", "urgent", 403],
    ] as const) {
      state.role = role;
      const res = await POST(post(`/api/studies/${STUDY}/state`, { flag, value: true, version: await currentVersion() }), params(STUDY));
      expect(res.status, `${role} ${flag}`).toBe(status);
    }
    expect(await lastAudit("study_state")).toMatchObject({ outcome: "denied", actorRole: "viewer" });

    state.role = "doctor";
    const { GET } = await import("@/app/api/studies/[uid]/route");
    const body = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY))).json();
    expect(body.study).toMatchObject({ inspected: true, read: true, urgent: false, stateVersion: 2 });
  });

  it("古い画面（読んだ時の版が古い）からの変更は 409 で書かず、競合を記録する", async () => {
    state.role = "doctor";
    const { POST } = await import("@/app/api/studies/[uid]/state/route");
    const v = await currentVersion();
    // ほかの利用者が先に既読を外した
    expect((await POST(post(`/api/studies/${STUDY}/state`, { flag: "read", value: false, version: v }), params(STUDY))).status).toBe(200);
    // 古い版の画面から既読にしようとする
    const res = await POST(post(`/api/studies/${STUDY}/state`, { flag: "read", value: true, version: v }), params(STUDY));
    expect(res.status).toBe(409);
    expect((await res.json()).version).toBe(v + 1);
    expect(await currentVersion()).toBe(v + 1);
    const row = await lastAudit("study_state");
    expect(row).toMatchObject({ outcome: "denied" });
    expect(JSON.parse(row!.detail!)).toMatchObject({ reason: "conflict", expected: v, current: v + 1 });
    const { GET } = await import("@/app/api/studies/[uid]/route");
    expect((await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY))).json()).study.read).toBe(false);
  });

  it("別の場所からの要求・決めた値の外・版の無い要求は断る", async () => {
    state.role = "admin";
    const { POST } = await import("@/app/api/studies/[uid]/state/route");
    const version = await currentVersion();
    expect((await POST(post(`/api/studies/${STUDY}/state`, { flag: "read", value: true, version }, "https://attacker.example.org"), params(STUDY))).status).toBe(403);
    expect((await POST(post(`/api/studies/${STUDY}/state`, { flag: "deleted", value: true, version }), params(STUDY))).status).toBe(400);
    expect((await POST(post(`/api/studies/${STUDY}/state`, { flag: "read", value: "yes", version }), params(STUDY))).status).toBe(400);
    expect((await POST(post(`/api/studies/${STUDY}/state`, { flag: "read", value: true }), params(STUDY))).status).toBe(400);
    expect(await currentVersion()).toBe(version);
  });
});

describe("権限で断ったものを記録する部品（requirePermission）", () => {
  it("権限が無ければ、断ったことを記録してから 403（一覧・詳細の検索の権限は既定の役割のどれにもあるので、部品を直に確かめる）", async () => {
    const { requirePermission } = await import("@/lib/auth/session");
    const session = { actorId: "dev", role: "viewer" as const, authMode: "dev" as const };
    await expect(requirePermission(session, "user.manage", { action: "search", detail: { via: "api" } })).rejects.toMatchObject({ status: 403 });
    const row = await lastAudit("search");
    expect(row).toMatchObject({ outcome: "denied", actorRole: "viewer" });
    expect(JSON.parse(row!.detail!)).toMatchObject({ via: "api", reason: "forbidden", permission: "user.manage" });
  });
});

describe("ビューア", () => {
  it("開く：監査の記録に残してから、ビューアの URL へ移す（同じ origin の画面から）", async () => {
    state.role = "viewer";
    const { GET } = await import("@/app/api/viewers/open/route");
    const res = await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=ohif`, { headers: { "sec-fetch-site": "same-origin" } }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://viewer.example.org/ohif/viewer?StudyInstanceUIDs=${STUDY}`);
    expect(await lastAudit("open_viewer")).toMatchObject({ studyInstanceUid: STUDY, actorRole: "viewer", outcome: "success" });
  });

  it.each([
    ["別のサイト", { "sec-fetch-site": "cross-site" }],
    ["同じサイトの別の origin", { "sec-fetch-site": "same-site" }],
    ["アドレスの欄から（画面の外）", { "sec-fetch-site": "none" }],
    ["Origin の違う要求", { origin: "https://other.example.org" }],
  ])("%s からの要求は、開かずに 403 で、断ったことだけを記録する", async (_label, headers) => {
    state.role = "doctor";
    const { GET } = await import("@/app/api/viewers/open/route");
    const res = await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=ohif`, { headers }));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    const row = await lastAudit("open_viewer");
    expect(row).toMatchObject({ outcome: "denied", studyInstanceUid: null });
    expect(JSON.parse(row!.detail!)).toMatchObject({ reason: "not-same-origin" });
  });

  it("DICOMweb の URL は移さずに返し、このアプリの監査の外と示す", async () => {
    state.role = "doctor";
    const { GET } = await import("@/app/api/viewers/open/route");
    const res = await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=dicomweb`));
    expect(await res.json()).toEqual({ url: `https://pacs.example.org/dicom-web/studies/${STUDY}`, outsideAudit: true });
  });

  it("設定されていないビューア・UID の形の誤りは 400", async () => {
    state.role = "doctor";
    const { GET } = await import("@/app/api/viewers/open/route");
    expect((await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=volview`))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=weasis`))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/api/viewers/open?study=javascript:1&viewer=ohif`))).status).toBe(400);
  });

  it("検査ごとの覚え：閲覧は断ったことが残り、医師はでき、設定に無いビューア・古い版は断る", async () => {
    const { POST } = await import("@/app/api/studies/[uid]/viewer/route");
    state.role = "viewer";
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: "stone", version: await currentVersion() }), params(STUDY))).status).toBe(403);
    const denied = await lastAudit("study_state");
    expect(denied).toMatchObject({ outcome: "denied", actorRole: "viewer" });
    expect(JSON.parse(denied!.detail!)).toMatchObject({ flag: "viewer", reason: "forbidden", permission: "viewer.remember" });
    state.role = "doctor";
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: "volview", version: await currentVersion() }), params(STUDY))).status).toBe(400);
    const v = await currentVersion();
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: "stone", version: v }), params(STUDY))).status).toBe(200);
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: "ohif", version: v }), params(STUDY))).status).toBe(409);
    const { GET } = await import("@/app/api/studies/[uid]/route");
    const body = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY))).json();
    expect(body.study).toMatchObject({ rememberedViewer: "stone", defaultViewer: "stone" });
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: null, version: v + 1 }), params(STUDY))).status).toBe(200);
  });

  it("モダリティの既定は管理者だけが変え（断ったものも記録）、変更は設定の変更として記録する", async () => {
    const route = await import("@/app/api/admin/viewer-defaults/route");
    state.role = "doctor";
    expect((await route.GET()).status).toBe(403);
    expect(await lastAudit("config_change")).toMatchObject({ outcome: "denied", actorRole: "doctor" });
    expect((await route.POST(post("/api/admin/viewer-defaults", { modality: "MG", viewer: "ohif" }))).status).toBe(403);
    const denied = await lastAudit("config_change");
    expect(JSON.parse(denied!.detail!)).toMatchObject({ method: "POST", modality: "MG", reason: "forbidden" });
    state.role = "admin";
    expect((await route.POST(post("/api/admin/viewer-defaults", { modality: "MG", viewer: "dicomweb" }))).status).toBe(400);
    expect((await route.POST(post("/api/admin/viewer-defaults", { modality: "MG", viewer: "ohif" }))).status).toBe(200);
    expect((await (await route.GET()).json()).defaults.MG).toBe("ohif");
    const row = await lastAudit("config_change");
    expect(row).toMatchObject({ outcome: "success", actorRole: "admin" });
    expect(JSON.parse(row!.detail!)).toMatchObject({ modality: "MG", from: null, to: "ohif" });
  });
});
