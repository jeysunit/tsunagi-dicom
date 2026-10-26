import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 送信一覧（docs/spec.md の 3.4）：監査の記録の送信の行と Orthanc の仕事から、期間の中の送信を新しい順に返す読むだけの画面の API。
// 期間の読み方・上限・状態の対応・役割ごとに許す・断る（断ったことも記録に残る）・許可の一覧に載っていない項目は返らない、を見る。

const state = vi.hoisted(() => ({
  role: undefined as string | undefined,
  config: undefined as AppConfig | undefined,
  denySendView: false,
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

// 既定の割り当てでは send.view を断る役割が無い（管理者と一般の両方に許す）ので、断る道は割り当てを替えて確かめる
vi.mock("@/lib/auth/roles", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/roles")>();
  return {
    ...real,
    can: (role: Parameters<typeof real.can>[0], permission: Parameters<typeof real.can>[1], map?: Parameters<typeof real.can>[2]) =>
      state.denySendView && permission === "send.view" ? false : real.can(role, permission, map),
  };
});

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-sent-log-");

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig({
    BACKEND_MOCK: "true",
    AUTH_MODE: "dev",
    DEV_ALLOW_WRITE: "true",
    SESSION_SECRET: "s".repeat(48),
    DATABASE_URL: dbs.freshUrl(),
    TZ: "Asia/Tokyo",
  });
}, 60_000);
afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  await (await getDb()).$disconnect();
  await dbs.closeAll();
  dbs.teardown();
});
beforeEach(() => {
  state.role = undefined;
  state.denySendView = false;
  vi.restoreAllMocks();
});

const uidParams = (uid: string) => ({ params: Promise.resolve({ uid }) });
async function send(modality: string) {
  const { POST } = await import("@/app/api/studies/[uid]/send/route");
  const requestId = crypto.randomUUID();
  const res = await POST(
    new Request(`${ORIGIN}/api/studies/${STUDY}/send`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, host: new URL(ORIGIN).host },
      body: JSON.stringify({ modality, requestId }),
    }),
    uidParams(STUDY),
  );
  return { requestId, res };
}
async function sentLog(search = "period=today") {
  const { GET } = await import("@/app/api/sent-log/route");
  return GET(new Request(`${ORIGIN}/api/sent-log?${search}`));
}
async function db() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}
const detailOf = (row: { detail: string | null } | null) => JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;

describe("期間の読み方", () => {
  // 2026-10-26 00:30（日本時間）。UTC では 10-25 15:30
  const now = new Date("2026-10-25T15:30:00Z");
  const range = async (search: string) => (await import("@/lib/sent-log")).sentRange(new URLSearchParams(search), "Asia/Tokyo", now);

  it("今日・昨日・過去7日は、時間帯（TZ）の日付の 0 時で区切る。過去7日は今日を含む7日", async () => {
    expect(await range("period=today")).toMatchObject({
      fromDate: "2026-10-26",
      toDate: "2026-10-26",
      from: new Date("2026-10-25T15:00:00Z"),
      to: new Date("2026-10-26T15:00:00Z"),
    });
    expect(await range("period=yesterday")).toMatchObject({ fromDate: "2026-10-25", toDate: "2026-10-25", from: new Date("2026-10-24T15:00:00Z") });
    expect(await range("period=week")).toMatchObject({ fromDate: "2026-10-20", toDate: "2026-10-26", from: new Date("2026-10-19T15:00:00Z") });
    // 条件が無ければ今日
    expect((await range("")).period).toBe("today");
  });

  it("期間を指定：開始日と終了日を両端を含めて読む。形の合わない日付・逆の順・知らない期間は 400", async () => {
    expect(await range("period=range&from=2026-10-01&to=2026-10-03")).toMatchObject({
      from: new Date("2026-09-30T15:00:00Z"),
      to: new Date("2026-10-03T15:00:00Z"),
    });
    for (const bad of ["period=range", "period=range&from=2026-10-01", "period=range&from=2026-02-30&to=2026-03-01", "period=range&from=2026-10-03&to=2026-10-01", "period=month"]) {
      await expect(range(bad), bad).rejects.toMatchObject({ status: 400 });
    }
  });

  it("夏時間のある時間帯でも、その日の 0 時を返す", async () => {
    const { startOfDayIn } = await import("@/lib/sent-log");
    expect(startOfDayIn({ year: 2026, month: 3, day: 8 }, "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(startOfDayIn({ year: 2026, month: 3, day: 9 }, "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("状態の対応", () => {
  const now = new Date("2026-10-25T03:00:00Z");
  const row = (seq: number, phase: string, outcome = "success", extra: Record<string, unknown> = {}, at = now) => ({
    seq,
    occurredAt: at,
    actorId: "u",
    outcome,
    patientId: "P1",
    studyInstanceUid: STUDY,
    detail: JSON.stringify({ phase, requestId: "r", ...extra }),
  });
  const JOB = "11111111-2222-3333-4444-555555555555";

  it("記録の行から：結果が無ければ、少しの間は送信待ち、過ぎれば結果不明。失敗・結果不明・照らした結果・終わりはその状態", async () => {
    const { sentStage } = await import("@/lib/sent-log");
    expect(sentStage([row(1, "request", "success", {}, new Date(now.getTime() - 30_000))], now)).toMatchObject({ kind: "final", status: "pending" });
    expect(sentStage([row(1, "request", "success", {}, new Date(now.getTime() - 10 * 60_000))], now)).toMatchObject({ kind: "final", status: "unknown" });
    expect(sentStage([row(1, "request"), row(2, "result", "failed")], now)).toMatchObject({ kind: "final", status: "failed" });
    expect(sentStage([row(1, "request"), row(2, "result", "unknown")], now)).toMatchObject({ kind: "final", status: "unknown", finishedAt: null });
    expect(sentStage([row(1, "request"), row(2, "result", "unknown"), row(3, "reconcile", "success")], now)).toMatchObject({ status: "sent" });
    expect(sentStage([row(1, "request"), row(2, "result", "unknown"), row(3, "reconcile", "failed")], now)).toMatchObject({ status: "failed" });
    expect(sentStage([row(1, "request"), row(2, "result", "success", { jobId: JOB })], now)).toEqual({ kind: "job", jobId: JOB });
    expect(sentStage([row(1, "request"), row(2, "result", "success", { jobId: JOB }), row(3, "done", "failed")], now)).toMatchObject({ status: "failed" });
    // 仕事の ID の無い「受けた」は、仕事を読めないので結果不明
    expect(sentStage([row(1, "request"), row(2, "result", "success")], now)).toMatchObject({ status: "unknown" });
  });

  it("Orthanc の仕事の状態：待ち・一時停止・再試行待ちは送信待ち、Running は送信中、Success・Failure は完了・失敗、履歴から消えた仕事は結果不明", async () => {
    const { jobSentStatus } = await import("@/lib/sent-log");
    expect(["Pending", "Paused", "Retry", "Running", "Success", "Failure"].map((s) => jobSentStatus(s as never))).toEqual([
      "pending",
      "pending",
      "pending",
      "running",
      "sent",
      "failed",
    ]);
    expect(jobSentStatus(null)).toBe("unknown");
  });
});

describe("送信一覧の画面の API", () => {
  it("一般には、今日の送信を新しい順に、状態・送信先・検査の項目とともに返し、開いたことを返した検査とともに記録する", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    const ok = await send("dtg");
    const failed = await send("offline");
    vi.spyOn(getBackend(), "sendStudy").mockRejectedValueOnce(new BackendUnknownError());
    const unknown = await send("workstation");
    expect([ok.res.status, failed.res.status, unknown.res.status]).toEqual([202, 202, 202]);

    // モックの仕事は、読むたびに 待ち → 送信中 → 終わり と進む
    const statuses: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const res = await sentLog();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items.map((r: { requestId: string }) => r.requestId)).toEqual([unknown.requestId, failed.requestId, ok.requestId]);
      statuses.push(body.items.map((r: { status: string }) => r.status));
      if (i === 0) {
        expect(body).toMatchObject({ truncated: false, limit: 1000 });
        expect(body.items[2]).toMatchObject({ destination: "dtg", destinationAet: "DTG_SCP", finishedAt: null });
        expect(body.items[2].study).toMatchObject({ studyInstanceUid: STUDY, patientId: "JP-TEST-0004", modalities: ["CT"] });
        expect(body.items[2].requestedAt).toMatch(/Z$/);
      }
    }
    expect(statuses).toEqual([
      ["unknown", "pending", "pending"],
      ["unknown", "running", "running"],
      ["unknown", "failed", "sent"],
    ]);

    // 仕事の終わりを初めて読んだので、終わりの記録を1行だけ足した（次に読んでも足さない）
    await sentLog();
    const done = (await (await db()).auditLog.findMany({ where: { action: "send", detail: { contains: `"phase":"done"` } } })).map(detailOf);
    expect(done.filter((d) => d.requestId === ok.requestId)).toEqual([expect.objectContaining({ via: "send_log", state: "Success" })]);
    expect(done.filter((d) => d.requestId === failed.requestId)).toEqual([expect.objectContaining({ via: "send_log", state: "Failure" })]);

    const opened = await (await db()).auditLog.findFirst({ where: { action: "send_log" }, orderBy: { seq: "desc" } });
    expect(opened).toMatchObject({ outcome: "success", actorRole: "general", patientId: "JP-TEST-0004", studyInstanceUid: null });
    expect(detailOf(opened)).toMatchObject({ period: "today", results: 3, truncated: false });
    expect(detailOf(opened).returned).toEqual([
      ["JP-TEST-0004", STUDY],
      ["JP-TEST-0004", STUDY],
      ["JP-TEST-0004", STUDY],
    ]);
  });

  it("仕事の ID・送った利用者・誤りの番号は返さない（許可の一覧に無い項目）", async () => {
    state.role = "admin";
    const body = await (await sentLog()).json();
    const { SENT_FIELDS, STUDY_FIELDS } = await import("@/lib/fields");
    for (const item of body.items) {
      for (const key of Object.keys(item)) expect([...SENT_FIELDS, "study"]).toContain(key);
      for (const key of Object.keys(item.study)) expect(STUDY_FIELDS).toContain(key);
    }
    const text = JSON.stringify(body);
    for (const hidden of ["jobId", "actorId", "errorCode", "dev"]) expect(text).not.toContain(`"${hidden}"`);
  });

  it("send.view の無い役割には断り、断ったことを記録する（Orthanc も記録の中身も読まない）", async () => {
    state.role = "general";
    state.denySendView = true;
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "studyDataset");
    const res = await sentLog();
    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty("items");
    expect(spy).not.toHaveBeenCalled();
    const row = await (await db()).auditLog.findFirst({ where: { action: "send_log" }, orderBy: { seq: "desc" } });
    expect(row).toMatchObject({ outcome: "denied", actorRole: "general" });
    expect(detailOf(row)).toMatchObject({ reason: "forbidden", permission: "send.view" });
  });

  it("仕事の状態を読めない送信は、一覧全体の誤りにせず、その行だけ結果不明にする", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const unknownCount = (items: { status: string }[]) => items.filter((r) => r.status === "unknown").length;
    await send("dtg");
    await send("dtg");
    // 前の試験の送信も同じ記録に残っているので、まず読んで、結果不明の数を控える
    const before = await (await sentLog()).json();
    vi.spyOn(getBackend(), "jobStatus").mockRejectedValueOnce(new Error("Orthanc に接続できません"));
    const res = await sentLog();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toHaveLength(before.items.length);
    expect(unknownCount(body.items)).toBe(unknownCount(before.items) + 1);
  });

  it("形の合わない期間は 400 で、記録の中身を返さない", async () => {
    state.role = "general";
    const res = await sentLog("period=range&from=2026-10-03&to=2026-10-01");
    expect(res.status).toBe(400);
    expect(await res.json()).not.toHaveProperty("items");
  });
});

describe("許可の一覧と上限", () => {
  const session = { actorId: "dev", role: "general", authMode: "dev" } as never;
  const range = (from: string, to: string) => ({ period: "range" as const, fromDate: from, toDate: to, from: new Date(from), to: new Date(to) });

  async function seed(count: number, base: Date, uid = STUDY) {
    const target = await dbs.fresh();
    const { appendAudit } = await import("@/lib/audit");
    for (let i = 0; i < count; i++) {
      await appendAudit(target, {
        actorId: "dev",
        actorRole: "general",
        authMode: "dev",
        action: "send",
        patientId: "JP-TEST-0004",
        studyInstanceUid: uid,
        occurredAt: new Date(base.getTime() + i * 1000),
        detail: { requestId: crypto.randomUUID(), modality: "dtg", aet: "DTG_SCP", phase: "request" },
      });
    }
    return target;
  }

  it("許可の一覧に載っていない項目は返らない。sent の一覧が無い役割には送信の項目を返さない", async () => {
    const { sentLogView } = await import("@/lib/sent-log");
    const { getBackend } = await import("@/lib/backend");
    const target = await seed(2, new Date("2026-01-10T01:00:00Z"));
    const deps = { db: target, backend: getBackend(), session, role: "general" as const };
    const narrow = await sentLogView(
      { ...deps, allowlists: { admin: { study: [], series: [] }, general: { study: ["patientId"], series: [], sent: ["status"] } } },
      range("2026-01-10T00:00:00Z", "2026-01-11T00:00:00Z"),
    );
    expect(narrow.items).toHaveLength(2);
    for (const item of narrow.items) {
      expect(Object.keys(item).sort()).toEqual(["status", "study"]);
      expect(Object.keys(item.study)).toEqual(["patientId"]);
    }
    const none = await sentLogView(
      { ...deps, allowlists: { admin: { study: [], series: [] }, general: { study: [], series: [] } } },
      range("2026-01-10T00:00:00Z", "2026-01-11T00:00:00Z"),
    );
    for (const item of none.items) expect(item).toEqual({ study: {} });
  });

  it("もう Orthanc に無い検査は、監査の記録の患者 ID と StudyInstanceUID だけを、許可の一覧で絞って返す", async () => {
    const { sentLogView } = await import("@/lib/sent-log");
    const gone = "1.2.826.0.1.3680043.8.498.1";
    const target = await seed(1, new Date("2026-01-10T01:00:00Z"), gone);
    const backend = { studyDataset: async () => null, jobStatus: async () => null };
    const window = range("2026-01-10T00:00:00Z", "2026-01-11T00:00:00Z");
    const full = await sentLogView({ db: target, backend, session, role: "general" }, window);
    expect(full.items[0]!.study).toEqual({ patientId: "JP-TEST-0004", studyInstanceUid: gone });
    const hidden = await sentLogView(
      { db: target, backend, session, role: "general", allowlists: { admin: { study: [], series: [] }, general: { study: ["studyInstanceUid"], series: [], sent: ["status"] } } },
      window,
    );
    expect(hidden.items[0]!.study).toEqual({ studyInstanceUid: gone });
  });

  it("期間の中が 1,000 件を超えたら、新しい 1,000 件だけを返し、超えたことを返す。期間の外は読まない", async () => {
    const { sentLogView, SENT_LIMIT } = await import("@/lib/sent-log");
    const base = new Date("2026-01-10T01:00:00Z");
    const target = await seed(SENT_LIMIT + 2, base);
    const backend = { studyDataset: async () => null, jobStatus: async () => null };
    const over = await sentLogView({ db: target, backend, session, role: "general" }, range("2026-01-10T00:00:00Z", "2026-01-11T00:00:00Z"));
    expect(over.truncated).toBe(true);
    expect(over.items).toHaveLength(SENT_LIMIT);
    const times = over.items.map((i) => i.requestedAt!);
    expect(times[0]).toBe(new Date(base.getTime() + (SENT_LIMIT + 1) * 1000).toISOString());
    expect(times).toEqual([...times].sort().reverse());
    // 最初の 2 件を外した範囲は、ちょうど上限なので超えていない
    const exact = await sentLogView(
      { db: target, backend, session, role: "general" },
      range(new Date(base.getTime() + 2000).toISOString(), "2026-01-11T00:00:00Z"),
    );
    expect(exact.truncated).toBe(false);
    expect(exact.items).toHaveLength(SENT_LIMIT);
  }, 120_000);
});
