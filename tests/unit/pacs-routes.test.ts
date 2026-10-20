import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 段 4 の画面の API（受け取りの記録・機器の一覧・C-ECHO・ほかの機器へ送る・送った仕事の状態。docs/spec.md の 3.3〜3.5）を、
// 検証モード（AUTH_MODE=dev。モックの Orthanc）のセッションから通して確かめる。
// 役割ごとに許す・断る、断ったことも記録に残る、監査の行（呼ぶ前・呼んだ後・終わり。要求の ID で結ぶ）、
// 同じ要求の ID を二度流さない、結果不明、CSRF（Origin）、検証モードの書き込みの止め、モックでの一巡りを見る。

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

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-pacs-routes-");

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
  state.config!.auth.devAllowWrite = true;
  vi.restoreAllMocks();
});

const uidParams = (uid: string) => ({ params: Promise.resolve({ uid }) });
const idParams = (id: string) => ({ params: Promise.resolve({ id }) });
const tokenParams = (token: string) => ({ params: Promise.resolve({ token }) });
function post(path: string, body: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(ORIGIN).host },
    body: JSON.stringify(body),
  });
}
async function db() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}
async function lastAudit(action: string) {
  return (await db()).auditLog.findFirst({ where: { action }, orderBy: { seq: "desc" } });
}
async function rowsOf(requestId: string) {
  return (await db()).auditLog.findMany({ where: { action: "send", detail: { contains: requestId } }, orderBy: { seq: "asc" } });
}
const detailOf = (row: { detail: string | null } | null) => JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;

async function send(body: unknown, origin = ORIGIN) {
  const { POST } = await import("@/app/api/studies/[uid]/send/route");
  return POST(post(`/api/studies/${STUDY}/send`, body, origin), uidParams(STUDY));
}
async function sendStatus(requestId: string) {
  const { GET } = await import("@/app/api/studies/[uid]/send/route");
  return GET(new Request(`${ORIGIN}/api/studies/${STUDY}/send?requestId=${requestId}`), uidParams(STUDY));
}
async function readJob(token: string) {
  const { GET } = await import("@/app/api/jobs/[token]/route");
  return GET(new Request(`${ORIGIN}/api/jobs/${token}`), tokenParams(token));
}
async function resolveSend(requestId: string, delivered: boolean, note = "受け取る側の記録で確かめた（試験）") {
  const { POST } = await import("@/app/api/studies/[uid]/send/resolve/route");
  return POST(post(`/api/studies/${STUDY}/send/resolve`, { requestId, delivered, note }), uidParams(STUDY));
}

// 結果不明の試験の後に、ほかの試験が同じ検査・同じ送り先へ送れるよう、残った結果不明を管理者が照らしておく
afterEach(async () => {
  vi.restoreAllMocks();
  const { unresolvedRequests } = await import("@/lib/pacs-ops");
  const pending = await unresolvedRequests(await db(), "send", STUDY, () => true);
  const role = state.role;
  state.role = "admin";
  for (const id of pending) await resolveSend(id, false);
  state.role = role;
});

describe("受け取りの記録", () => {
  it("一般には、受け取った検査を新しい順に、時刻・送ってきた機器・画像の数とともに返し、返した検査を記録する", async () => {
    state.role = "general";
    const { GET } = await import("@/app/api/receive-log/route");
    const res = await GET();
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items).toHaveLength(8);
    expect(items[0]).toMatchObject({ receivedAt: "2026-10-17T13:32:00Z", remoteAet: "DTG_SCU", receivedInstances: 6 });
    expect(items[0].study).toMatchObject({ patientId: "JP-TEST-0004", modalities: ["MR"] });
    // REST で入った検査は、送ってきた機器が無く、入った道が分かる
    expect(items.find((i: { study: { patientId: string }; origin: string }) => i.origin === "RestApi")).toMatchObject({ remoteAet: null });
    const times = items.map((i: { receivedAt: string }) => i.receivedAt);
    expect(times).toEqual([...times].sort().reverse());
    const row = await lastAudit("receive_log");
    expect(row).toMatchObject({ outcome: "success", actorRole: "general" });
    expect((detailOf(row).returned as unknown[]).length).toBe(8);
  });

  // 外した試験：「医師・閲覧には断る」。役割を管理者と一般の2つにし（2026-10-20）、受信一覧は両方が使うので、断る役割が無い
});

describe("機器の一覧と C-ECHO", () => {
  it("管理者には住所まで、一般には名前と AE タイトルだけを返す", async () => {
    const { GET } = await import("@/app/api/modalities/route");
    state.role = "admin";
    const admin = (await (await GET()).json()).modalities;
    expect(admin.map((m: { id: string }) => m.id)).toEqual(["dtg", "offline", "workstation"]);
    expect(admin[0]).toMatchObject({ id: "dtg", aet: "DTG_SCP", host: "192.0.2.20", port: 11112 });
    state.role = "general";
    const tech = (await (await GET()).json()).modalities;
    for (const m of tech) expect(Object.keys(m).sort()).toEqual(["aet", "id"]);
    // 外した確かめ：閲覧には断る（閲覧の役割を無くした。2026-10-20）
  });

  it("つながる機器・つながらない機器・登録の無い機器を確かめ、結果を記録する", async () => {
    state.role = "general";
    const { POST } = await import("@/app/api/modalities/[id]/echo/route");
    const ok = await POST(post("/api/modalities/dtg/echo", {}), idParams("dtg"));
    expect(await ok.json()).toEqual({ modality: "dtg", connected: true });
    expect(detailOf(await lastAudit("echo"))).toMatchObject({ modality: "dtg", connected: true });
    const ng = await POST(post("/api/modalities/offline/echo", {}), idParams("offline"));
    expect(await ng.json()).toEqual({ modality: "offline", connected: false });
    expect(await lastAudit("echo")).toMatchObject({ outcome: "failed" });
    expect((await POST(post("/api/modalities/nothing/echo", {}), idParams("nothing"))).status).toBe(404);
    expect((await POST(post("/api/modalities/..%2Fx/echo", {}), idParams("../x"))).status).toBe(400);
  });

  it("別の Origin からの C-ECHO の要求は断る（CSRF）", async () => {
    state.role = "admin";
    const { POST } = await import("@/app/api/modalities/[id]/echo/route");
    expect((await POST(post("/api/modalities/dtg/echo", {}, "https://attacker.example.org"), idParams("dtg"))).status).toBe(403);
  });
});

describe("ほかの機器へ送る", () => {
  it("モックで一巡りする：送ると仕事の ID を受け、状態は終わりまで進み、呼ぶ前・呼んだ後・終わりを要求の ID で結んで記録する", async () => {
    state.role = "general";
    const requestId = crypto.randomUUID();
    const res = await send({ modality: "dtg", requestId });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ requestId, outcome: "accepted" });
    const states: string[] = [];
    for (let i = 0; i < 5; i++) {
      const job = await (await readJob(body.job)).json();
      states.push(job.state);
      if (job.state === "Success") break;
    }
    expect(states).toEqual(["Pending", "Running", "Success"]);
    // 終わりを何度読んでも、終わりの記録は1行
    await readJob(body.job);
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => detailOf(r).phase)).toEqual(["request", "result", "done"]);
    expect(rows.map((r) => r.outcome)).toEqual(["success", "success", "success"]);
    expect(rows[0]).toMatchObject({ patientId: "JP-TEST-0004", studyInstanceUid: STUDY, actorRole: "general" });
    expect(detailOf(rows[0]!)).toMatchObject({ modality: "dtg", aet: "DTG_SCP" });
    expect(detailOf(rows[1]!).jobId).toBe(detailOf(rows[2]!).jobId);
    // 仕事の中身（Content）は返さない
    const final = await (await readJob(body.job)).json();
    expect(Object.keys(final).sort()).toEqual(["completionTime", "creationTime", "errorCode", "errorDescription", "progress", "state"]);
  });

  it("つながらない機器へ送ると、仕事は失敗で終わり、失敗を記録する", async () => {
    state.role = "admin";
    const requestId = crypto.randomUUID();
    const { job } = await (await send({ modality: "offline", requestId })).json();
    let last = "";
    for (let i = 0; i < 5 && last !== "Failure"; i++) last = (await (await readJob(job)).json()).state;
    expect(last).toBe("Failure");
    const rows = await rowsOf(requestId);
    expect(rows.at(-1)).toMatchObject({ outcome: "failed" });
    expect(detailOf(rows.at(-1)!)).toMatchObject({ phase: "done", state: "Failure", errorCode: 9 });
  });

  // 外した試験：「医師・閲覧には断る」。送信は管理者と一般の両方が使う（2026-10-20）ので、役割で断る相手が無い。
  // 断ったときに Orthanc を呼ばず記録に残ることは、下の検証モードの書き込みの止めの試験で見る

  it("同じ要求の ID は二度流さない：Orthanc を呼び直さず、前の結果を返す", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "sendStudy");
    const requestId = crypto.randomUUID();
    const first = await (await send({ modality: "dtg", requestId })).json();
    const again = await send({ modality: "dtg", requestId });
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ requestId, outcome: "accepted", repeated: true });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(first.outcome).toBe("accepted");
    // ほかの利用者の要求の ID を断ることは、検証モードでは利用者が1人（dev）なので、下の requestOutcome の試験で見る
  });

  it("Orthanc の答えが分からなければ「結果不明」を返し、unknown として記録する。確かめの道は送り直さない", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    const spy = vi.spyOn(getBackend(), "sendStudy").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    const res = await send({ modality: "dtg", requestId });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ requestId, outcome: "unknown" });
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "unknown"],
    ]);
    // 確かめの道（GET）と、同じ要求の ID の送り直しは、Orthanc を呼ばない
    const { GET } = await import("@/app/api/studies/[uid]/send/route");
    const status = await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/send?requestId=${requestId}`), uidParams(STUDY));
    expect(await status.json()).toMatchObject({ requestId, outcome: "unknown" });
    expect(await (await send({ modality: "dtg", requestId })).json()).toMatchObject({ outcome: "unknown", repeated: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("Orthanc が断れば失敗を記録し、誤りを返す", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const { BackendError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "sendStudy").mockRejectedValueOnce(new BackendError("画像サーバーの応答が 500"));
    const requestId = crypto.randomUUID();
    expect((await send({ modality: "dtg", requestId })).status).toBe(502);
    expect((await rowsOf(requestId)).map((r) => r.outcome)).toEqual(["success", "failed"]);
  });

  it("呼ぶ前の記録ができなければ、Orthanc を呼ばない", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "sendStudy");
    const session = await import("@/lib/auth/session");
    vi.spyOn(session, "auditIf").mockRejectedValueOnce(new Error("記録の失敗"));
    expect((await send({ modality: "dtg", requestId: crypto.randomUUID() })).status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });

  it("別の Origin・形の誤った本文・登録の無い機器・無い検査は断る", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "sendStudy");
    expect((await send({ modality: "dtg", requestId: crypto.randomUUID() }, "https://attacker.example.org")).status).toBe(403);
    expect((await send({ modality: "dtg", requestId: "not-a-uuid" })).status).toBe(400);
    expect((await send({ modality: "../x", requestId: crypto.randomUUID() })).status).toBe(400);
    expect((await send({ modality: "nothing", requestId: crypto.randomUUID() })).status).toBe(404);
    const { POST } = await import("@/app/api/studies/[uid]/send/route");
    expect((await POST(post("/api/studies/1.2.3/send", { modality: "dtg", requestId: crypto.randomUUID() }), uidParams("1.2.3"))).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("検証モードで書き込みを止めているときは断り、断ったことを記録する（DEV_ALLOW_WRITE の既定）", async () => {
    state.role = "admin";
    state.config!.auth.devAllowWrite = false;
    const requestId = crypto.randomUUID();
    expect((await send({ modality: "dtg", requestId })).status).toBe(403);
    const rows = await rowsOf(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied" });
    expect(detailOf(rows[0]!)).toMatchObject({ reason: "dev_write_blocked" });
  });

  it("仕事の状態：書き換えた token・期限の過ぎた token・ほかの利用者の token は読ませない。token の中身は読めない", async () => {
    state.role = "general";
    const { job } = await (await send({ modality: "dtg", requestId: crypto.randomUUID() })).json();
    // 中身（UID・利用者）は暗号化していて、token の文字に出ない
    expect(job).not.toContain(STUDY);
    expect(Buffer.from((job as string).split(".")[2]!, "base64url").toString("latin1")).not.toContain("1.2.826");
    const parts = (job as string).split(".");
    const body = Buffer.from(parts[2]!, "base64url");
    body[0] = body[0]! ^ 1;
    parts[2] = body.toString("base64url");
    expect((await readJob(parts.join("."))).status).toBe(404);
    expect((await readJob("garbage")).status).toBe(404);
    expect((await readJob("%E0%A4%A")).status).toBe(404);
    const { signJobToken, openJobToken, JOB_TOKEN_TTL_MS } = await import("@/lib/pacs-ops");
    const payload = openJobToken(job, state.config!.sessionSecret)!;
    // 鍵が合っても、ほかの利用者の名前で作った token は読ませない
    expect((await readJob(signJobToken({ ...payload, actorId: "someone-else" }, state.config!.sessionSecret))).status).toBe(404);
    // 期限が過ぎた token
    expect((await readJob(signJobToken(payload, state.config!.sessionSecret, Date.now() - JOB_TOKEN_TTL_MS - 1000))).status).toBe(404);
    // ほかの鍵（SESSION_SECRET を替えた後）の token
    expect(openJobToken(signJobToken(payload, "t".repeat(48)), state.config!.sessionSecret)).toBeNull();
    // 外した確かめ：閲覧には仕事の状態を読ませない（閲覧の役割を無くした。2026-10-20）
  });

  it("同じ要求の ID が並んで届いても、Orthanc を呼ぶのは1回、「求めた」の行も1つ", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "sendStudy");
    const requestId = crypto.randomUUID();
    const answers = await Promise.all([1, 2, 3].map(() => send({ modality: "dtg", requestId })));
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await rowsOf(requestId)).filter((r) => detailOf(r).phase === "request")).toHaveLength(1);
  });

  it("同じ要求の ID で、別の検査・別の送り先を求めると 409（前の送信の「受けた」を返さない）", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "sendStudy");
    const requestId = crypto.randomUUID();
    expect((await send({ modality: "dtg", requestId })).status).toBe(202);
    expect((await send({ modality: "workstation", requestId })).status).toBe(409);
    const other = "1.2.826.0.1.3680043.8.498.1";
    const { POST, GET } = await import("@/app/api/studies/[uid]/send/route");
    expect((await POST(post(`/api/studies/${other}/send`, { modality: "dtg", requestId }), uidParams(other))).status).toBe(409);
    expect((await GET(new Request(`${ORIGIN}/api/studies/${other}/send?requestId=${requestId}`), uidParams(other))).status).toBe(409);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("答えが分からず、結果の記録にも失敗しても、結果不明として返す（誤りとして送り直しを誘わない）", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "sendStudy").mockRejectedValueOnce(new BackendUnknownError());
    const session = await import("@/lib/auth/session");
    const real = session.audit;
    vi.spyOn(session, "audit").mockImplementation(async (s, fields) => {
      if ((fields.detail as { phase?: string } | undefined)?.phase === "result") throw new Error("記録の失敗");
      return real(s, fields);
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await send({ modality: "dtg", requestId: crypto.randomUUID() });
    expect(res.status).toBe(202);
    expect((await res.json()).outcome).toBe("unknown");
    // 照らすための要求の ID は残し、患者の値は出さない
    expect(JSON.stringify(error.mock.calls)).toContain("send_result_not_recorded");
    expect(JSON.stringify(error.mock.calls)).not.toContain("JP-TEST");
  });

  it("断った行は「求めた」と読まれない：断った後に同じ要求の ID で送れる", async () => {
    // 断る道は、前は医師の役割（役割で断る）。医師の役割を無くした（2026-10-20）ので、検証モードの書き込みの止めで断る
    state.role = "general";
    state.config!.auth.devAllowWrite = false;
    const requestId = crypto.randomUUID();
    expect((await send({ modality: "dtg", requestId })).status).toBe(403);
    state.config!.auth.devAllowWrite = true;
    expect(detailOf((await rowsOf(requestId))[0]!).phase).toBeUndefined();
    state.role = "general";
    expect(await (await send({ modality: "dtg", requestId })).json()).toMatchObject({ outcome: "accepted" });
  });

  it("仕事の終わりを並んで読んでも、終わりの行は1つ", async () => {
    state.role = "general";
    const requestId = crypto.randomUUID();
    const { job } = await (await send({ modality: "dtg", requestId })).json();
    await readJob(job);
    await readJob(job);
    await Promise.all([readJob(job), readJob(job), readJob(job)]);
    expect((await rowsOf(requestId)).filter((r) => detailOf(r).phase === "done")).toHaveLength(1);
  });

  it("結果不明の送信があるうちは、同じ検査を同じ送り先へ、新しい要求の ID でも送れない（照らし合わせの後は送れる）", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    const spy = vi.spyOn(getBackend(), "sendStudy").mockRejectedValueOnce(new BackendUnknownError());
    const first = crypto.randomUUID();
    expect((await (await send({ modality: "dtg", requestId: first })).json()).outcome).toBe("unknown");
    // 新しい要求の ID でも、同じ送り先へは断る。断ったことも記録する
    const second = crypto.randomUUID();
    const blocked = await send({ modality: "dtg", requestId: second });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).pendingRequestIds).toEqual([first]);
    expect(detailOf((await rowsOf(second))[0]!)).toMatchObject({ reason: "unresolved", pending: [first] });
    // 別の送り先へは送れる
    expect((await send({ modality: "workstation", requestId: crypto.randomUUID() })).status).toBe(202);
    expect(spy).toHaveBeenCalledTimes(2);
    // 一般は照らし合わせを記録できない。管理者が送り先で確かめて記録する
    expect((await resolveSend(first, false)).status).toBe(403);
    state.role = "admin";
    expect(await (await resolveSend(first, false)).json()).toEqual({ requestId: first, outcome: "not_delivered" });
    expect((await rowsOf(first)).at(-1)).toMatchObject({ outcome: "failed", actorRole: "admin" });
    expect(detailOf((await rowsOf(first)).at(-1)!)).toMatchObject({ phase: "reconcile", manual: true, delivered: false });
    // 結果の分かった送信は、もう照らせない
    expect((await resolveSend(first, true)).status).toBe(409);
    // 照らした後は、同じ送り先へ送れる
    state.role = "general";
    expect((await send({ modality: "dtg", requestId: crypto.randomUUID() })).status).toBe(202);
  });

  it("解いていない結果不明の送信は、8 日たっても止めになり、確かめの道と照らし合わせから見える", async () => {
    state.role = "general";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "sendStudy").mockRejectedValueOnce(new BackendUnknownError());
    const first = crypto.randomUUID();
    expect((await (await send({ modality: "dtg", requestId: first })).json()).outcome).toBe("unknown");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
      const blocked = await send({ modality: "dtg", requestId: crypto.randomUUID() });
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).pendingRequestIds).toEqual([first]);
      expect(await (await sendStatus(first)).json()).toMatchObject({ requestId: first, outcome: "unknown" });
      state.role = "admin";
      expect(await (await resolveSend(first, false)).json()).toEqual({ requestId: first, outcome: "not_delivered" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("照らし合わせで「届いていた」と記録した送信は、確かめの道で「届いた」を返す", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "sendStudy").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    await send({ modality: "dtg", requestId });
    expect((await resolveSend(requestId, true)).status).toBe(200);
    const { GET } = await import("@/app/api/studies/[uid]/send/route");
    const status = await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/send?requestId=${requestId}`), uidParams(STUDY));
    expect(await status.json()).toMatchObject({ requestId, outcome: "delivered" });
    // 照らし合わせの理由が無ければ断る
    const { POST } = await import("@/app/api/studies/[uid]/send/resolve/route");
    expect((await POST(post(`/api/studies/${STUDY}/send/resolve`, { requestId, delivered: true, note: " " }), uidParams(STUDY))).status).toBe(400);
  });
});

describe("要求の記録の読み方（requestOutcome）", () => {
  it("求めた利用者・結果・仕事の ID を、記録の行から読む", async () => {
    const { requestOutcome } = await import("@/lib/pacs-ops");
    const job = "11111111-2222-4333-8444-555555555555";
    const row = (outcome: string, detail: Record<string, unknown>, actorId = "alice") => ({ actorId, outcome, detail: JSON.stringify(detail) });
    expect(requestOutcome([])).toEqual({
      phase: "none",
      outcome: null,
      jobId: null,
      actorId: null,
      studyInstanceUid: null,
      modality: null,
      requestedAt: null,
      dispatched: false,
    });
    // 削除の「送る」の行（dispatch）は、結果ではない（結果不明のまま、送ったことだけが分かる）
    expect(requestOutcome([row("success", { phase: "request" }), row("success", { phase: "dispatch" })])).toMatchObject({
      phase: "requested",
      dispatched: true,
    });
    // 断った行だけなら「求めた」は無い
    expect(requestOutcome([row("denied", { requestId: "x", reason: "forbidden" })]).phase).toBe("none");
    expect(requestOutcome([row("success", { phase: "request" })])).toMatchObject({ phase: "requested", actorId: "alice" });
    expect(requestOutcome([row("success", { phase: "request" }), row("unknown", { phase: "result" })])).toMatchObject({ phase: "result", outcome: "unknown" });
    expect(
      requestOutcome([row("success", { phase: "request" }), row("success", { phase: "result", jobId: job }), row("failed", { phase: "done", jobId: job })]),
    ).toMatchObject({ phase: "done", outcome: "failed", jobId: job });
    // 求めた利用者は、最初の「求めた」の行の利用者（あとから同じ ID を使った人ではない）
    expect(requestOutcome([row("success", { phase: "request" }, "alice"), row("denied", { phase: "duplicate" }, "bob")]).actorId).toBe("alice");
  });
});
