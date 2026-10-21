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

// 一般の役割だけ、シリーズの項目を SeriesInstanceUID だけに狭める（管理者は既定）。2026-10-20 に役割を管理者と一般の2つにしたので、
// 前の「閲覧を狭め、医師・技師で既定を見る」形を「一般を狭め、管理者で既定を見る」形にした（確かめる中身は同じ）
vi.mock("@/lib/fields", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/fields")>();
  const map = { ...real.ROLE_FIELD_ALLOWLIST, general: { study: ["studyInstanceUid"] as const, series: ["seriesInstanceUid"] as const } };
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
    state.role = "admin";
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
    expect(row).toMatchObject({ actorRole: "admin", studyInstanceUid: STUDY, patientId: "JP-TEST-0004" });
  });

  it("許可の一覧を狭めた役割には、載っていない検査・シリーズの項目が返らない", async () => {
    state.role = "general";
    const { GET } = await import("@/app/api/studies/[uid]/route");
    const body = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY))).json();
    expect(Object.keys(body.study)).toEqual(["studyInstanceUid"]);
    for (const s of body.series) expect(Object.keys(s)).toEqual(["seriesInstanceUid"]);
    expect(JSON.stringify(body)).not.toMatch(/JP-TEST-|髙子|Chest/);
  });

  it("UID の形が誤りなら 400、見つからなければ 404", async () => {
    state.role = "admin";
    const { GET } = await import("@/app/api/studies/[uid]/route");
    expect((await GET(new Request(`${ORIGIN}/api/studies/x`), params("../x"))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/api/studies/1.2.3`), params("1.2.3"))).status).toBe(404);
  });
});

/** いまのビューアの覚えの版（画面が読んだ時の版の代わり） */
async function currentVersion() {
  const { getDb } = await import("@/lib/db");
  return (await (await getDb()).studyViewer.findUnique({ where: { studyInstanceUid: STUDY } }))?.version ?? 0;
}

describe("すべての DICOM の値（別の権限）", () => {
  // 役割は管理者と一般の2つで、どちらも DICOM タグを見られる（2026-10-20）。前の医師・閲覧の 403 の行は、役割を無くしたので外した
  it.each([
    ["admin", 200],
    ["general", 200],
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

describe("画像単位の DICOM タグ（dicom.all_values。docs/spec.md の 3.1）", () => {
  const seriesParams = (uid: string, series: string) => ({ params: Promise.resolve({ uid, series }) });
  const sopParams = (uid: string, series: string, sop: string) => ({ params: Promise.resolve({ uid, series, sop }) });
  async function firstSeries() {
    const { createMockBackend } = await import("@/lib/backend/mock");
    return (await createMockBackend().searchSeries(STUDY))[0]!.seriesInstanceUid;
  }

  it("シリーズの中の画像の並び：選ぶのに要る値だけを画像の番号の順に返し、開いたことを記録する", async () => {
    state.role = "general";
    const series = await firstSeries();
    const { GET } = await import("@/app/api/studies/[uid]/series/[series]/instances/route");
    const res = await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/series/${series}/instances`), seriesParams(STUDY, series));
    expect(res.status).toBe(200);
    const { instances } = await res.json();
    expect(instances).toHaveLength(4);
    for (const i of instances) expect(Object.keys(i).sort()).toEqual(["instanceNumber", "numberOfFrames", "sopClassUid", "sopInstanceUid"]);
    expect(instances.map((i: { instanceNumber: string }) => i.instanceNumber)).toEqual(["1", "2", "3", "4"]);
    const row = await lastAudit("view_study");
    expect(row).toMatchObject({ outcome: "success", actorRole: "general", studyInstanceUid: STUDY, patientId: "JP-TEST-0004" });
    expect(JSON.parse(row!.detail!)).toMatchObject({ allValues: true, level: "instances", seriesInstanceUid: series, count: 4 });
  });

  it("1枚の画像の値の全部：選んだ画像の SOPInstanceUID と値を返す（画像ごとに値が違う）。開いたことを画像の UID つきで記録する", async () => {
    state.role = "general";
    const series = await firstSeries();
    const list = await import("@/app/api/studies/[uid]/series/[series]/instances/route");
    const { instances } = await (await list.GET(new Request(`${ORIGIN}/x`), seriesParams(STUDY, series))).json();
    const { GET } = await import("@/app/api/studies/[uid]/series/[series]/instances/[sop]/values/route");
    const read = async (sop: string) => {
      const res = await GET(new Request(`${ORIGIN}/x`), sopParams(STUDY, series, sop));
      expect(res.status).toBe(200);
      return (await res.json()).values as { tag: string; vr: string; value: string }[];
    };
    const [a, b] = [await read(instances[0].sopInstanceUid), await read(instances[1].sopInstanceUid)];
    const value = (rows: typeof a, tag: string) => rows.find((r) => r.tag === tag)?.value;
    expect(value(a, "0008,0018")).toBe(instances[0].sopInstanceUid);
    expect(value(b, "0008,0018")).toBe(instances[1].sopInstanceUid);
    expect(value(a, "0010,0020")).toBe("JP-TEST-0004");
    expect(value(a, "0020,000E")).toBe(series);
    expect(value(a, "0020,0032")).not.toBe(value(b, "0020,0032"));
    // 検査の検索だけにある項目（ModalitiesInStudy など）は、画像の値に無い
    expect(value(a, "0008,0061")).toBeUndefined();
    const row = await lastAudit("view_study");
    expect(row).toMatchObject({ outcome: "success", studyInstanceUid: STUDY, patientId: "JP-TEST-0004" });
    expect(JSON.parse(row!.detail!)).toMatchObject({ allValues: true, level: "instance", seriesInstanceUid: series, sopInstanceUid: instances[1].sopInstanceUid });
  });

  it("UID の形が誤りなら 400、見つからない画像・ほかのシリーズの画像は 404", async () => {
    state.role = "admin";
    const series = await firstSeries();
    const { GET } = await import("@/app/api/studies/[uid]/series/[series]/instances/[sop]/values/route");
    expect((await GET(new Request(`${ORIGIN}/x`), sopParams(STUDY, "../x", "1.2"))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/x`), sopParams(STUDY, series, "1.2;x"))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/x`), sopParams(STUDY, series, "1.2.3"))).status).toBe(404);
    const list = await import("@/app/api/studies/[uid]/series/[series]/instances/route");
    const { instances } = await (await list.GET(new Request(`${ORIGIN}/x`), seriesParams(STUDY, series))).json();
    // 同じ画像でも、別のシリーズの下としては返さない
    expect((await GET(new Request(`${ORIGIN}/x`), sopParams(STUDY, "1.2.3", instances[0].sopInstanceUid))).status).toBe(404);
  });
});

describe("一覧の版（自動更新。docs/spec.md の 3.1）", () => {
  it("変更の記録の番号だけを返し、患者の情報を返さないので監査の記録を増やさない。消すと版が進む", async () => {
    state.role = "general";
    const { GET } = await import("@/app/api/studies/version/route");
    const { getDb } = await import("@/lib/db");
    const before = await (await getDb()).auditLog.count();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["version"]);
    expect(body.version).toMatch(/^\d+$/);
    expect(await (await getDb()).auditLog.count()).toBe(before);

    const { createMockBackend, restoreMockStudies } = await import("@/lib/backend/mock");
    const backend = createMockBackend();
    const id = await backend.lookupStudy(STUDY);
    await backend.deleteStudy(id!);
    try {
      expect((await (await GET()).json()).version).toBe(String(Number(body.version) + 1));
    } finally {
      restoreMockStudies();
    }
  });
});

describe("段 3：検査の状態の印は返さない", () => {
  it("詳細の検査に、状態の印の項目（検像・読影・緊急・ブックマーク）が無い", async () => {
    state.role = "admin";
    const { GET } = await import("@/app/api/studies/[uid]/route");
    const body = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY))).json();
    for (const removed of ["inspected", "read", "urgent", "bookmarked", "stateVersion"]) expect(body.study).not.toHaveProperty(removed);
    expect(body.study).toHaveProperty("viewerVersion");
  });
});

describe("権限で断ったものを記録する部品（requirePermission）", () => {
  it("権限が無ければ、断ったことを記録してから 403（一覧・詳細の検索の権限は既定の役割のどれにもあるので、部品を直に確かめる）", async () => {
    const { requirePermission } = await import("@/lib/auth/session");
    const session = { actorId: "dev", role: "general" as const, authMode: "dev" as const };
    await expect(requirePermission(session, "user.manage", { action: "search", detail: { via: "api" } })).rejects.toMatchObject({ status: 403 });
    const row = await lastAudit("search");
    expect(row).toMatchObject({ outcome: "denied", actorRole: "general" });
    expect(JSON.parse(row!.detail!)).toMatchObject({ via: "api", reason: "forbidden", permission: "user.manage" });
  });
});

describe("ビューア", () => {
  it("開く：監査の記録に残してから、ビューアの URL へ移す（同じ origin の画面から）", async () => {
    state.role = "general";
    const { GET } = await import("@/app/api/viewers/open/route");
    const res = await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=ohif`, { headers: { "sec-fetch-site": "same-origin" } }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`https://viewer.example.org/ohif/viewer?StudyInstanceUIDs=${STUDY}`);
    expect(await lastAudit("open_viewer")).toMatchObject({ studyInstanceUid: STUDY, actorRole: "general", outcome: "success" });
  });

  it.each([
    ["別のサイト", { "sec-fetch-site": "cross-site" }],
    ["同じサイトの別の origin", { "sec-fetch-site": "same-site" }],
    ["アドレスの欄から（画面の外）", { "sec-fetch-site": "none" }],
    ["Origin の違う要求", { origin: "https://other.example.org" }],
  ])("%s からの要求は、開かずに 403 で、断ったことだけを記録する", async (_label, headers) => {
    state.role = "admin";
    const { GET } = await import("@/app/api/viewers/open/route");
    const res = await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=ohif`, { headers }));
    expect(res.status).toBe(403);
    expect(res.headers.get("location")).toBeNull();
    const row = await lastAudit("open_viewer");
    expect(row).toMatchObject({ outcome: "denied", studyInstanceUid: null });
    expect(JSON.parse(row!.detail!)).toMatchObject({ reason: "not-same-origin" });
  });

  it("DICOMweb の URL は移さずに返し、このアプリの監査の外と示す", async () => {
    state.role = "admin";
    const { GET } = await import("@/app/api/viewers/open/route");
    const res = await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=dicomweb`));
    expect(await res.json()).toEqual({ url: `https://pacs.example.org/dicom-web/studies/${STUDY}`, outsideAudit: true });
  });

  it("設定されていないビューア・UID の形の誤りは 400", async () => {
    state.role = "admin";
    const { GET } = await import("@/app/api/viewers/open/route");
    expect((await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=volview`))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/api/viewers/open?study=${STUDY}&viewer=weasis`))).status).toBe(400);
    expect((await GET(new Request(`${ORIGIN}/api/viewers/open?study=javascript:1&viewer=ohif`))).status).toBe(400);
  });

  // 外した確かめ：「閲覧は断ったことが残る」。閲覧の役割を無くし（2026-10-20）、検査ごとの覚えは管理者と一般の両方が使う
  it("検査ごとの覚え：一般はでき、設定に無いビューア・古い版は断る", async () => {
    const { POST } = await import("@/app/api/studies/[uid]/viewer/route");
    state.role = "general";
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: "volview", version: await currentVersion() }), params(STUDY))).status).toBe(400);
    const v = await currentVersion();
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: "stone", version: v }), params(STUDY))).status).toBe(200);
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: "ohif", version: v }), params(STUDY))).status).toBe(409);
    const { GET } = await import("@/app/api/studies/[uid]/route");
    // この試験では一般の許可の一覧を狭めているので、覚えの値は既定の一覧の管理者で読む
    state.role = "admin";
    const body = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}`), params(STUDY))).json();
    expect(body.study).toMatchObject({ rememberedViewer: "stone", defaultViewer: "stone" });
    state.role = "general";
    expect((await POST(post(`/api/studies/${STUDY}/viewer`, { viewer: null, version: v + 1 }), params(STUDY))).status).toBe(200);
  });

  it("モダリティの既定は管理者だけが変え（断ったものも記録）、変更は設定の変更として記録する", async () => {
    const route = await import("@/app/api/admin/viewer-defaults/route");
    state.role = "general";
    expect((await route.GET()).status).toBe(403);
    expect(await lastAudit("config_change")).toMatchObject({ outcome: "denied", actorRole: "general" });
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
