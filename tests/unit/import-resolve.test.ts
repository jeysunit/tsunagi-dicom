import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { dicomFile } from "./helpers/dicom-file";
import { testDatabases } from "./helpers/test-db";

// 段 6 のインポートの、管理者が手で解く道（POST /api/studies/{uid}/import/resolve。docs/spec.md の 3.5「取り込み」）と、
// 状態の確認（GET /api/import）を照らし合わせの役割（管理者）にも開いたことを確認する。
// 解けるのは管理者だけ（一般は断り、断ったことも記録に残る）・CSRF（Origin）・確認内容が必須・結果の行の無い要求は決めた時間を
// 過ぎるまで解かない・「成功」は画像があると読めたときだけ・解いた後は同じ検査のインポートが止まらない、を見る。

const state = vi.hoisted(() => ({
  role: undefined as string | undefined,
  config: undefined as AppConfig | undefined,
  /** 記録を書く前（auditIf・audit が headers を読むとき）に呼ぶ。処理を途中で止める試験に使う */
  beforeRecord: undefined as (() => Promise<void>) | undefined,
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
    headers: async () => {
      await state.beforeRecord?.();
      return new Headers();
    },
  };
});

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => state.config! };
});

// モックの見本の検査（tests/fixtures/orthanc）。モックはこれらの UID のファイルだけを受ける
const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const PATIENT = "JP-TEST-0004";
const STUDY_MISMATCH = "1.2.826.0.1.3680043.8.498.12580196157444326238324642149044327503";
const STUDY_CLEANUP = "1.2.826.0.1.3680043.8.498.73812431209939638312153431926357964288";
// 記録だけに追加する要求の検査（Orthanc には無い）
const STUDY_RECORDED = "1.2.826.0.1.3680043.8.498.11111111111111111111111111111111111111";
const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-import-resolve-");

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig({
    BACKEND_MOCK: "true",
    AUTH_MODE: "dev",
    DEV_ALLOW_WRITE: "true",
    SESSION_SECRET: "s".repeat(48),
    DATABASE_URL: dbs.freshUrl(),
    IMPORT_MAX_MB: "1",
  });
}, 60_000);
afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  await (await getDb()).$disconnect();
  dbs.teardown();
});
beforeEach(async () => {
  state.role = "general";
  state.beforeRecord = undefined;
  state.config!.auth.devAllowWrite = true;
  vi.restoreAllMocks();
  const { restoreMockStudies, simulateMockImport } = await import("@/lib/backend/mock");
  restoreMockStudies();
  simulateMockImport({});
});

let sop = 100;
const nextSop = () => `1.2.826.0.1.3680043.8.498.8${sop++}`;

async function post(body: Uint8Array, requestId: string = crypto.randomUUID()) {
  const { POST } = await import("@/app/api/import/route");
  return POST(
    new Request(`${ORIGIN}/api/import`, {
      method: "POST",
      headers: { "content-type": "application/dicom", origin: ORIGIN, host: new URL(ORIGIN).host, "x-request-id": requestId },
      body: body as Uint8Array<ArrayBuffer>,
    }),
  );
}
async function status(requestId: string, study?: string) {
  const { GET } = await import("@/app/api/import/route");
  return GET(new Request(`${ORIGIN}/api/import?requestId=${requestId}${study ? `&study=${study}` : ""}`));
}
async function resolve(uid: string, body: Record<string, unknown>, origin = ORIGIN) {
  const { POST } = await import("@/app/api/studies/[uid]/import/resolve/route");
  return POST(
    new Request(`${ORIGIN}/api/studies/${uid}/import/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: new URL(ORIGIN).host },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ uid }) },
  );
}
async function db() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}
async function rowsOf(requestId: string) {
  return (await db()).auditLog.findMany({ where: { action: "import", detail: { contains: requestId } }, orderBy: { seq: "asc" } });
}
const detailOf = (row: { detail: string | null } | undefined | null) => JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;
async function backend() {
  const { getBackend } = await import("@/lib/backend");
  return getBackend();
}
async function removeStudy(uid: string) {
  const b = await backend();
  await b.deleteStudy((await b.lookupStudy(uid))!);
}
/** Orthanc が保存した患者 ID を、ファイルの値と違うものに見せる */
async function storedPatientDiffers() {
  const b = await backend();
  const real = b.studyInfo.bind(b);
  vi.spyOn(b, "studyInfo").mockImplementation(async (id) => {
    const info = await real(id);
    return info && { ...info, patientId: "JP-TEST-0099" };
  });
}
/** ほかの利用者の取り込みの行を、記録にだけ追加する（結果の行は phases で選ぶ） */
async function recordedImport(phases: readonly ("request" | "result")[], actorId = "someone") {
  const { appendAudit } = await import("@/lib/audit");
  const requestId = crypto.randomUUID();
  for (const phase of phases) {
    await appendAudit(await db(), {
      actorId,
      actorRole: "general",
      authMode: "dev",
      action: "import",
      outcome: phase === "request" ? "success" : "unknown",
      patientId: PATIENT,
      studyInstanceUid: STUDY_RECORDED,
      detail: { requestId, phase, sopInstanceUid: nextSop(), sha256: "0".repeat(64) },
    });
  }
  return requestId;
}

describe("インポートの結果不明を管理者が手で解く", () => {
  it("値の違う画像が見つかった結果不明は、管理者が「失敗」と名指しして解き、同じ検査のインポートが止まらなくなる", async () => {
    await removeStudy(STUDY_MISMATCH);
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    const sopUid = nextSop();
    await post(dicomFile({ studyInstanceUid: STUDY_MISMATCH, sopInstanceUid: sopUid, patientId: "JP-TEST-0001" }), requestId);
    simulateMockImport({});
    await storedPatientDiffers();
    // 状態の確認では解けない（見つけた画像がこの要求の入れたものとは言えない）
    expect((await status(requestId)).status).toBe(202);

    // 一般は解けない。断ったことも記録に残る
    expect((await resolve(STUDY_MISMATCH, { requestId, outcome: "failed", note: "試験" })).status).toBe(403);
    const denied = (await rowsOf(requestId)).at(-1);
    expect(denied).toMatchObject({ outcome: "denied", actorRole: "general", studyInstanceUid: STUDY_MISMATCH });
    expect(detailOf(denied)).toMatchObject({ via: "resolve" });

    state.role = "admin";
    // 別の画面からの要求（Origin が違う）は 403 で、何も記録しない
    const count = (await rowsOf(requestId)).length;
    expect((await resolve(STUDY_MISMATCH, { requestId, outcome: "failed", note: "試験" }, "http://evil.example")).status).toBe(403);
    expect((await rowsOf(requestId)).length).toBe(count);
    // 確認内容が無い・結果の指定が無い・違う検査の URL は断る
    expect((await resolve(STUDY_MISMATCH, { requestId, outcome: "failed", note: " " })).status).toBe(400);
    expect((await resolve(STUDY_MISMATCH, { requestId, note: "試験" })).status).toBe(400);
    expect((await resolve(STUDY, { requestId, outcome: "failed", note: "試験" })).status).toBe(404);

    const solved = await resolve(STUDY_MISMATCH, { requestId, outcome: "failed", note: "Orthanc で、ほかの道で届いた画像と確かめた（試験）" });
    expect(solved.status).toBe(200);
    expect(await solved.json()).toEqual({ requestId, outcome: "failed", instancePresent: true });
    const last = (await rowsOf(requestId)).at(-1);
    expect(last).toMatchObject({ outcome: "failed", actorRole: "admin", patientId: "JP-TEST-0001", studyInstanceUid: STUDY_MISMATCH });
    expect(detailOf(last)).toMatchObject({
      phase: "reconcile",
      manual: true,
      instancePresent: true,
      sopInstanceUid: sopUid,
      orthancInstanceId: expect.any(String),
      note: "Orthanc で、ほかの道で届いた画像と確かめた（試験）",
    });
    // 解いた後は、もう一度は解けず、状態の確認は失敗を返す
    expect((await resolve(STUDY_MISMATCH, { requestId, outcome: "success", note: "試験" })).status).toBe(409);
    expect(await (await status(requestId)).json()).toMatchObject({ requestId, outcome: "failed" });
    // 同じ検査のインポートは、解いていない要求で止まらない（残った画像を Orthanc で消した後）
    vi.restoreAllMocks();
    await removeStudy(STUDY_MISMATCH);
    const again = await post(dicomFile({ studyInstanceUid: STUDY_MISMATCH, sopInstanceUid: nextSop(), patientId: "JP-TEST-0001" }));
    expect(again.status).toBe(200);
  });

  it("入れた画像を消せなかった要求は、残った画像を名指しで読み、管理者が「成功」と名指しすると成功として解く", async () => {
    await removeStudy(STUDY_CLEANUP);
    await storedPatientDiffers();
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ deleteUnknown: true });
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY_CLEANUP, sopInstanceUid: nextSop(), patientId: PATIENT }), requestId);
    simulateMockImport({});
    expect(res.status).toBe(502);
    const cleanup = detailOf((await rowsOf(requestId)).find((r) => detailOf(r).phase === "cleanup_request")).orthancInstanceId;
    expect(cleanup).toEqual(expect.any(String));
    const label = vi.spyOn(await backend(), "labelImported");

    state.role = "admin";
    const solved = await resolve(STUDY_CLEANUP, { requestId, outcome: "success", note: "Orthanc で値を確かめ、残すと決めた（試験）" });
    expect(await solved.json()).toEqual({ requestId, outcome: "stored", instancePresent: true });
    expect(detailOf((await rowsOf(requestId)).at(-1))).toMatchObject({ phase: "reconcile", manual: true, orthancInstanceId: cleanup });
    expect((await rowsOf(requestId)).at(-1)).toMatchObject({ outcome: "success" });
    // Orthanc には書き込みを求めない（印も付けない）
    expect(label).not.toHaveBeenCalled();
  });

  /** 「求めた」を記録した後、Orthanc へ送る前（「送る」の行を追加する前）で、その要求の処理を止めておく */
  async function pausedBeforeDispatch(file: Uint8Array) {
    const requestId = crypto.randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let paused = false;
    state.beforeRecord = async () => {
      if (paused) return;
      const phases = (await rowsOf(requestId)).map((r) => detailOf(r).phase);
      if (phases.includes("request") && !phases.includes("dispatch")) {
        paused = true;
        reached();
        await gate;
      }
    };
    const answer = post(file, requestId);
    await atGate;
    return { requestId, answer, release };
  }

  it("並べて走らせる：送る前に止まっていた要求は、管理者が解いた後に動き出しても Orthanc へ送らない（後から入れた画像を置き換えない）", async () => {
    await removeStudy(STUDY);
    const sopUid = nextSop();
    const file = dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT });
    const send = vi.spyOn(await backend(), "importInstance");
    const { requestId, answer, release } = await pausedBeforeDispatch(file);
    state.role = "admin";
    // 決めた時間の中は、処理中として解かない
    expect((await resolve(STUDY, { requestId, outcome: "failed", note: "試験" })).status).toBe(409);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect(await (await resolve(STUDY, { requestId, outcome: "failed", note: "試験：止まった処理を片付ける" })).json()).toEqual({
        requestId,
        outcome: "failed",
        instancePresent: false,
      });
      // 解いた後に、同じ画像を新しい要求で入れ直す
      const again = await post(file);
      expect(again.status).toBe(200);
      expect(send).toHaveBeenCalledTimes(1);
      // 止まっていた元の処理が動き出しても、送らずに断る
      release();
      const res = await answer;
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("ほかで解除された");
      expect(send).toHaveBeenCalledTimes(1);
      expect((await rowsOf(requestId)).map((r) => detailOf(r).phase)).toEqual(["request", "reconcile"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("並べて走らせる：送る前に決めた時間を過ぎた要求は、Orthanc へ送らずに失敗（stale）とする", async () => {
    const STUDY_STALE = "1.2.826.0.1.3680043.8.498.45255015335478509141706689498950755880";
    await removeStudy(STUDY_STALE);
    const send = vi.spyOn(await backend(), "importInstance");
    const { requestId, answer, release } = await pausedBeforeDispatch(
      dicomFile({ studyInstanceUid: STUDY_STALE, sopInstanceUid: nextSop(), patientId: "JP-TEST-0001" }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60_000);
      release();
      const res = await answer;
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("時間切れ");
    } finally {
      vi.useRealTimers();
    }
    expect(send).not.toHaveBeenCalled();
    const last = (await rowsOf(requestId)).at(-1);
    expect(last).toMatchObject({ outcome: "failed" });
    expect(detailOf(last)).toMatchObject({ phase: "result", refused: "stale" });
  });

  it("並べて走らせる：状態の確認が照らしている間に管理者が解いたら、状態の確認は成功を足さず、印も付けない", async () => {
    await removeStudy(STUDY_MISMATCH);
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    await post(dicomFile({ studyInstanceUid: STUDY_MISMATCH, sopInstanceUid: nextSop(), patientId: "JP-TEST-0001" }), requestId);
    simulateMockImport({});
    // 状態の確認を、Orthanc が保存した値を読むところで止める
    const b = await backend();
    const real = b.studyInfo.bind(b);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    vi.spyOn(b, "studyInfo").mockImplementationOnce(async (id) => {
      reached();
      await gate;
      return real(id);
    });
    const label = vi.spyOn(b, "labelImported");
    const checking = status(requestId);
    await atGate;
    state.role = "admin";
    expect((await resolve(STUDY_MISMATCH, { requestId, outcome: "failed", note: "試験：ほかの道で届いた画像と確かめた" })).status).toBe(200);
    release();
    expect(await (await checking).json()).toMatchObject({ requestId, outcome: "failed", repeated: true });
    expect(label).not.toHaveBeenCalled();
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["dispatch", "success"],
      ["result", "unknown"],
      ["reconcile", "failed"],
    ]);
  });

  it("画像が Orthanc に無ければ「成功」として記録しない（「失敗」としては解ける）", async () => {
    state.role = "admin";
    const requestId = await recordedImport(["request", "result"]);
    const res = await resolve(STUDY_RECORDED, { requestId, outcome: "success", note: "試験" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("見つかりません");
    expect((await rowsOf(requestId)).length).toBe(2);
    expect(await (await resolve(STUDY_RECORDED, { requestId, outcome: "failed", note: "試験" })).json()).toEqual({
      requestId,
      outcome: "failed",
      instancePresent: false,
    });
  });

  it("結果の行の無い要求は、決めた時間を過ぎるまで解かない（元の処理がまだ動いているかもしれない）", async () => {
    state.role = "admin";
    const requestId = await recordedImport(["request"]);
    const running = await resolve(STUDY_RECORDED, { requestId, outcome: "failed", note: "試験" });
    expect(running.status).toBe(409);
    expect((await running.json()).error).toContain("まだ処理中");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      expect((await resolve(STUDY_RECORDED, { requestId, outcome: "failed", note: "試験：止まった処理を片付ける" })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ほかの利用者の結果不明は、管理者なら状態の確認で照らせる（一般は 409）", async () => {
    const requestId = await recordedImport(["request", "result"]);
    const general = await status(requestId, STUDY_RECORDED);
    expect(general.status).toBe(409);
    state.role = "admin";
    const admin = await status(requestId, STUDY_RECORDED);
    expect(admin.status).toBe(202);
    expect(await admin.json()).toMatchObject({ requestId, outcome: "unknown", studyInstanceUid: STUDY_RECORDED });
    await resolve(STUDY_RECORDED, { requestId, outcome: "failed", note: "試験" });
    expect(await (await status(requestId, STUDY_RECORDED)).json()).toMatchObject({ requestId, outcome: "failed" });
  });

  it("8 日たった結果不明も、検査を名指しすれば照らせて、手で解ける", async () => {
    state.role = "admin";
    const requestId = await recordedImport(["request", "result"]);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
      expect(await (await status(requestId, STUDY_RECORDED)).json()).toMatchObject({ outcome: "unknown" });
      expect((await resolve(STUDY_RECORDED, { requestId, outcome: "failed", note: "試験" })).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
