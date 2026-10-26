import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 段 5 の画面の API（書き出し・削除。docs/spec.md の 3.5）を、検証モード（AUTH_MODE=dev。モックの Orthanc）のセッションから通して確かめる。
// 削除は管理者のほかを断る、書き出しは役割の表（3.6）どおり、断ったことも記録に残る、監査の行（誰が・いつ・どの検査を・理由）、
// 同じ要求の ID を二度流さない、結果不明と照らし合わせ、CSRF（Origin）、検証モードの書き込みの止め、モックでの一巡りを見る。
// 再認証（AUTH_MODE=local）は tests/e2e/local-auth.spec.ts で見る。

const state = vi.hoisted(() => ({
  role: undefined as string | undefined,
  config: undefined as AppConfig | undefined,
  /** true のときは、Next.js と同じく、要求の外（答えを返した後）で headers() を読むと失敗させる */
  scoped: false,
  inRequest: false,
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
      if (state.scoped && !state.inRequest) throw new Error("`headers` was called outside a request scope");
      return new Headers({ "x-forwarded-for": "192.0.2.10" });
    },
  };
});

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => state.config! };
});

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-pacs-routes-2-");

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
  state.scoped = false;
  state.inRequest = false;
  state.config!.auth.devAllowWrite = true;
  vi.restoreAllMocks();
});
afterEach(async () => {
  // 試験が残した結果不明の削除を、管理者が手で解いて片付ける（次の試験が「結果の分からない削除がある」で断られないように）
  vi.restoreAllMocks();
  const { unresolvedRequests } = await import("@/lib/pacs-ops");
  const pending = await unresolvedRequests(await db(), "delete", STUDY, () => true);
  state.role = "admin";
  for (const id of pending) await resolveDelete({ requestId: id, note: "試験の片付け" });
  const { restoreMockStudies } = await import("@/lib/backend/mock");
  restoreMockStudies();
});

const uidParams = (uid: string) => ({ params: Promise.resolve({ uid }) });
async function db() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}
const detailOf = (row: { detail: string | null } | null | undefined) => JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;
async function lastAudit(action: string) {
  return (await db()).auditLog.findFirst({ where: { action }, orderBy: { seq: "desc" } });
}
async function exportRows(requestId: string) {
  return (await db()).auditLog.findMany({ where: { action: "export", detail: { contains: requestId } }, orderBy: { seq: "asc" } });
}
async function rowsOf(requestId: string) {
  return (await db()).auditLog.findMany({ where: { action: "delete", detail: { contains: requestId } }, orderBy: { seq: "asc" } });
}

async function exportZip(headers: Record<string, string> = { "sec-fetch-site": "same-origin" }, uid = STUDY) {
  const { GET } = await import("@/app/api/studies/[uid]/export/route");
  return GET(new Request(`${ORIGIN}/api/studies/${uid}/export`, { headers }), uidParams(uid));
}
/** 確かめの画面の token（いまの役割で確かめの画面を開いた形。開けなければ形だけの値） */
async function confirmTokenOf(uid = STUDY): Promise<string> {
  const res = await preview(uid);
  return res.ok ? ((await res.json()).confirmToken as string) : "d1.none.none.none";
}
/** 削除を求める。本文に confirmToken が無ければ、いま確かめの画面を開いて token を添える（確かめの画面を通った形） */
async function del(body: Record<string, unknown>, origin = ORIGIN, uid = STUDY) {
  const { POST } = await import("@/app/api/studies/[uid]/delete/route");
  const withToken = "confirmToken" in body ? body : { ...body, confirmToken: await confirmTokenOf(uid) };
  return POST(
    new Request(`${ORIGIN}/api/studies/${uid}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: new URL(ORIGIN).host },
      body: JSON.stringify(withToken),
    }),
    uidParams(uid),
  );
}
/** 結果の分からない削除を、管理者が手で解く */
async function resolveDelete(body: Record<string, unknown>, uid = STUDY) {
  const { POST } = await import("@/app/api/studies/[uid]/delete/resolve/route");
  return POST(
    new Request(`${ORIGIN}/api/studies/${uid}/delete/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, host: new URL(ORIGIN).host },
      body: JSON.stringify(body),
    }),
    uidParams(uid),
  );
}
async function preview(uid = STUDY) {
  const { GET } = await import("@/app/api/studies/[uid]/delete/route");
  return GET(new Request(`${ORIGIN}/api/studies/${uid}/delete`), uidParams(uid));
}
async function delStatus(requestId: string, uid = STUDY) {
  const { GET } = await import("@/app/api/studies/[uid]/delete/route");
  return GET(new Request(`${ORIGIN}/api/studies/${uid}/delete?requestId=${requestId}`), uidParams(uid));
}
async function listed(uid = STUDY) {
  const { getBackend } = await import("@/lib/backend");
  return (await getBackend().searchStudies()).studies.some((s) => s.studyInstanceUid === uid);
}

describe("書き出し（ZIP）", () => {
  it("管理者・一般は落とせ、落とす前に記録する。ファイルの名前に患者の情報を入れない", async () => {
    for (const role of ["admin", "general"]) {
      state.role = role;
      const res = await exportZip();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(disposition).toMatch(/^attachment; filename="study-[0-9a-f]{8}\.zip"$/);
      expect(disposition).not.toMatch(/JP-TEST|1\.2\.826/);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      // 「求めた」と「流し終えた」を分けて記録し、要求の ID で結ぶ
      await vi.waitFor(async () => expect(detailOf(await lastAudit("export"))).toMatchObject({ phase: "result", bytes: bytes.byteLength }));
      const rows = await exportRows(detailOf(await lastAudit("export")).requestId as string);
      expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
        ["request", "success"],
        ["result", "success"],
      ]);
      expect(rows[0]).toMatchObject({ actorRole: role, patientId: "JP-TEST-0004", studyInstanceUid: STUDY });
    }
  });

  it("流す途中で切れたら（Orthanc の側）、途中で切れたと記録する", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    let sent = false;
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
        } else controller.error(new Error("切れた"));
      },
    });
    vi.spyOn(getBackend(), "exportStudy").mockResolvedValueOnce(new Response(broken, { headers: { "content-type": "application/zip" } }));
    const res = await exportZip();
    expect(res.status).toBe(200);
    await expect(res.arrayBuffer()).rejects.toThrow();
    await vi.waitFor(async () => expect(detailOf(await lastAudit("export"))).toMatchObject({ phase: "result", interrupted: true, bytes: 4 }));
    expect(await lastAudit("export")).toMatchObject({ outcome: "failed" });
  });

  it("結果の行を書き終えてから本文を閉じる。結果を記録できなくても流れは止めず、BFF のログに残す", async () => {
    state.role = "admin";
    // 本文を読み終えた時点で、もう「流し終えた」の行がある（待たずに）
    const res = await exportZip();
    const size = (await res.arrayBuffer()).byteLength;
    expect(detailOf(await lastAudit("export"))).toMatchObject({ phase: "result", bytes: size });
    // 結果の行を書けない：本文は最後まで渡り、ログに残す
    const session = await import("@/lib/auth/session");
    const real = session.audit;
    let calls = 0;
    vi.spyOn(session, "audit").mockImplementation(async (...args: Parameters<typeof real>) => {
      calls += 1;
      if (calls === 2) throw new Error("記録の失敗");
      return real(...args);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const again = await exportZip();
    expect((await again.arrayBuffer()).byteLength).toBe(size);
    expect(log.mock.calls.some((c) => String(c[0]).includes("export_result_not_recorded"))).toBe(true);
  });

  // 結合の試験（実の Orthanc。#30）で、流し終えたときの結果の行が残らないと分かった（BFF のログに export_result_not_recorded）。
  // 結果は答えを返した後に書くので、その時には要求の headers() を読めない。要求の間に送り元を取っておき、結果の記録に渡す
  it("流し終えた・切られたときの結果の行は、答えを返した後（要求の外）でも残り、送り元も要求の時のもの", async () => {
    state.role = "admin";
    state.scoped = true;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const end of ["read", "cancel"] as const) {
      state.inRequest = true;
      const res = await exportZip();
      state.inRequest = false;
      expect(res.status).toBe(200);
      const requestId = detailOf(await lastAudit("export")).requestId as string;
      if (end === "read") await res.arrayBuffer();
      else await res.body!.cancel();
      await vi.waitFor(async () => expect((await exportRows(requestId)).length).toBe(2));
      const rows = await exportRows(requestId);
      expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
        ["request", "success"],
        ["result", end === "read" ? "success" : "failed"],
      ]);
      expect(rows[1]).toMatchObject({ sourceAddressUnverified: "192.0.2.10", actorRole: "admin", studyInstanceUid: STUDY });
    }
    expect(log.mock.calls.some((c) => String(c[0]).includes("export_result_not_recorded"))).toBe(false);
  });

  it("ブラウザの側で切ったら、切られたと記録する", async () => {
    state.role = "admin";
    const res = await exportZip();
    await res.body!.cancel();
    await vi.waitFor(async () => expect(detailOf(await lastAudit("export"))).toMatchObject({ phase: "result", cancelled: true }));
    expect(await lastAudit("export")).toMatchObject({ outcome: "failed" });
  });

  // 外した試験：「閲覧には断る」。閲覧の役割を無くし（2026-10-20）、エクスポートは管理者と一般の両方が使う

  it("このアプリの画面のほか（別のサイト・別の origin）からの要求は断る", async () => {
    state.role = "admin";
    expect((await exportZip({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await exportZip({ origin: "https://attacker.example.org" })).status).toBe(403);
    expect(detailOf(await lastAudit("export"))).toMatchObject({ reason: "not-same-origin" });
  });

  it("記録できなければ渡さず、Orthanc が断れば失敗を記録する", async () => {
    state.role = "admin";
    const session = await import("@/lib/auth/session");
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "exportStudy");
    vi.spyOn(session, "audit").mockRejectedValueOnce(new Error("記録の失敗"));
    expect((await exportZip()).status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const { BackendError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "exportStudy").mockRejectedValueOnce(new BackendError("画像サーバーの応答が 500"));
    expect((await exportZip()).status).toBe(502);
    expect(await lastAudit("export")).toMatchObject({ outcome: "failed" });
  });

  it("検証モードで書き込みを止めているときは断る・無い検査は 404", async () => {
    state.role = "admin";
    state.config!.auth.devAllowWrite = false;
    expect((await exportZip()).status).toBe(403);
    expect(detailOf(await lastAudit("export"))).toMatchObject({ reason: "dev_write_blocked" });
    state.config!.auth.devAllowWrite = true;
    expect((await exportZip(undefined, "1.2.3")).status).toBe(404);
  });
});

describe("削除", () => {
  it("モックで一巡りする：管理者が理由を書いて消すと、一覧から消え、呼ぶ前と後を要求の ID で結んで、理由とともに記録する", async () => {
    state.role = "admin";
    expect(await listed()).toBe(true);
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "  取り違えた検査（試験）  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requestId, outcome: "deleted" });
    expect(await listed()).toBe(false);
    const rows = await rowsOf(requestId);
    // 求めた → DELETE を送る直前の「送る」の行 → 結果
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["dispatch", "success"],
      ["result", "success"],
    ]);
    expect(rows[0]).toMatchObject({ actorRole: "admin", patientId: "JP-TEST-0004", studyInstanceUid: STUDY });
    expect(detailOf(rows[0])).toMatchObject({ reason: "取り違えた検査（試験）", series: 1, instances: 4 });
    // 消えた検査は、受け取りの記録・引き当てにも出ない
    const { getBackend } = await import("@/lib/backend");
    expect(await getBackend().lookupStudy(STUDY)).toBeNull();
    expect((await getBackend().receivedStudies({ fromMs: 0, toMs: Number.MAX_SAFE_INTEGER, limit: 1000 })).studies.some((r) => r.summary.studyInstanceUid === STUDY)).toBe(false);
  });

  it("管理者のほかの役割には断り、Orthanc を呼ばずに、断ったことを記録する", async () => {
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    // 役割は管理者と一般の2つ（2026-10-20）。前の医師・技師・閲覧の代わりに一般で確かめる
    for (const role of ["general"]) {
      state.role = role;
      const requestId = crypto.randomUUID();
      expect((await del({ requestId, reason: "試験" })).status).toBe(403);
      const rows = await rowsOf(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "denied", actorRole: role });
      expect(detailOf(rows[0])).toMatchObject({ reason: "forbidden", permission: "study.delete" });
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await listed()).toBe(true);
  });

  it("理由が無い・空白だけ・長すぎるものは断る", async () => {
    state.role = "admin";
    for (const reason of [undefined, "", "   ", "x".repeat(501)]) {
      expect((await del({ requestId: crypto.randomUUID(), reason })).status).toBe(400);
    }
    expect(await listed()).toBe(true);
  });

  it("同じ要求の ID は二度流さない（並んで届いても、Orthanc を呼ぶのは1回）", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const requestId = crypto.randomUUID();
    const answers = await Promise.all([1, 2, 3].map(() => del({ requestId, reason: "試験" })));
    // 先の1つが消し、残りは、先の要求の途中なら結果不明（202）、終わっていれば「消えた」（200）を返す
    expect(answers.map((a) => a.status).filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(answers.every((a) => a.status === 200 || a.status === 202)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await (await del({ requestId, reason: "試験" })).json()).toMatchObject({ outcome: "deleted", repeated: true });
    // 同じ要求の ID で別の検査を指すと 409
    const other = "1.2.826.0.1.3680043.8.498.1";
    expect((await del({ requestId, reason: "試験" }, ORIGIN, other)).status).toBe(409);
  });

  it("答えが分からなければ結果不明。照らすと、Orthanc に検査が無ければ「消えた」と記録に足す（もう一度消さない）", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    const backend = getBackend();
    // Orthanc では消えたが、答えが届かなかった形
    const real = backend.deleteStudy.bind(backend);
    const spy = vi.spyOn(backend, "deleteStudy").mockImplementationOnce(async (id) => {
      await real(id);
      throw new BackendUnknownError();
    });
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "試験" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ requestId, outcome: "unknown" });
    const status = await delStatus(requestId);
    expect(await status.json()).toEqual({ requestId, outcome: "deleted", reconciled: true });
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["dispatch", "success"],
      ["result", "unknown"],
      ["reconcile", "success"],
    ]);
    // 照らした後は、同じ要求の ID の送り直しも「消えた」を返し、Orthanc を呼ばない
    expect(await (await del({ requestId, reason: "試験" })).json()).toMatchObject({ outcome: "deleted", repeated: true });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("答えが分からず、Orthanc に検査が残っていれば「消えていない」と照らす", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "deleteStudy").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    await del({ requestId, reason: "試験" });
    // 検査がまだあるだけでは「消えていない」と確定させない（先の DELETE が止まった・終わった証拠が無い）。記録にも足さない
    const early = await delStatus(requestId);
    expect(early.status).toBe(202);
    expect(await early.json()).toMatchObject({ requestId, outcome: "unknown", studyPresent: true });
    expect((await rowsOf(requestId)).at(-1)).toMatchObject({ outcome: "unknown" });
    // 時間がたっても同じ（自動では確定させない）
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60_000);
    expect(await (await delStatus(requestId)).json()).toMatchObject({ outcome: "unknown", studyPresent: true });
    vi.restoreAllMocks();
    expect((await rowsOf(requestId)).at(-1)).toMatchObject({ outcome: "unknown" });
    // 結果不明の間は、同じ検査の削除を新しい要求の ID でも断る
    const blocked = await del({ requestId: crypto.randomUUID(), reason: "試験" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).pendingRequestIds).toEqual([requestId]);
    // 解くのは、管理者が確かめた内容を書いて手で解く操作だけ（一般は解けない）
    state.role = "general";
    expect((await resolveDelete({ requestId, note: "試験" })).status).toBe(403);
    state.role = "admin";
    expect((await resolveDelete({ requestId, note: "" })).status).toBe(400);
    const solved = await resolveDelete({ requestId, note: "Orthanc のログで、先の削除が途中で止まったことを確かめた（試験）" });
    expect(await solved.json()).toEqual({ requestId, outcome: "not_deleted" });
    expect((await rowsOf(requestId)).at(-1)).toMatchObject({ outcome: "failed" });
    expect(detailOf((await rowsOf(requestId)).at(-1))).toMatchObject({ phase: "reconcile", manual: true, studyPresent: true });
    // 解いた後は、もう一度は解けず、新しい削除を求められる
    expect((await resolveDelete({ requestId, note: "試験" })).status).toBe(409);
    expect((await del({ requestId: crypto.randomUUID(), reason: "試験" })).status).toBe(200);
  });

  it("解いていない結果不明の削除は、8 日たっても止めになり、照会と手で解く道から見える", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "deleteStudy").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験" })).status).toBe(202);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60_000);
      const blocked = await del({ requestId: crypto.randomUUID(), reason: "試験" });
      expect(blocked.status).toBe(409);
      expect((await blocked.json()).pendingRequestIds).toEqual([requestId]);
      expect(await (await delStatus(requestId)).json()).toMatchObject({ requestId, outcome: "unknown", studyPresent: true });
      expect(await (await resolveDelete({ requestId, note: "試験" })).json()).toEqual({ requestId, outcome: "not_deleted" });
    } finally {
      vi.useRealTimers();
    }
  });

  /** 消す直前の読み直し（2 回目の引き当て）で止めておき、その間にほかの操作を挟む */
  async function pausedDelete(confirmToken: string) {
    const { getBackend } = await import("@/lib/backend");
    const backend = getBackend();
    const real = backend.lookupStudyIds.bind(backend);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reached!: () => void;
    const atGate = new Promise<void>((r) => (reached = r));
    let calls = 0;
    vi.spyOn(backend, "lookupStudyIds").mockImplementation(async (uid) => {
      calls += 1;
      if (calls === 2) {
        reached();
        await gate;
      }
      return real(uid);
    });
    const requestId = crypto.randomUUID();
    const answer = del({ requestId, reason: "試験", confirmToken });
    await atGate;
    return { requestId, answer, release };
  }

  it("並べて走らせる：DELETE を送る前の「求めた」のままの要求は、手で解けない（409）。元の処理はそのまま消す", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const confirmToken = await confirmTokenOf();
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const { requestId, answer, release } = await pausedDelete(confirmToken);
    const res = await resolveDelete({ requestId, note: "試験" });
    expect(res.status).toBe(409);
    // 文言は 2026-10-20 に画面の用語集（docs/spec.md の 2.2）に合わせた。確かめる中身（処理中の要求は解かない）は同じ
    expect((await res.json()).error).toContain("まだ処理中");
    release();
    expect((await answer).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("並べて走らせる：送る前に決めた時間を過ぎた要求は手で解ける。解かれた要求は、元の処理が DELETE を送らない", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const confirmToken = await confirmTokenOf();
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const { requestId, answer, release } = await pausedDelete(confirmToken);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60_000);
      expect(await (await resolveDelete({ requestId, note: "試験：止まった処理を片付ける" })).json()).toEqual({ requestId, outcome: "not_deleted" });
      release();
      const res = await answer;
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("ほかで解除された");
    } finally {
      vi.useRealTimers();
    }
    expect(spy).not.toHaveBeenCalled();
    expect(await listed()).toBe(true);
    expect((await rowsOf(requestId)).map((r) => detailOf(r).phase)).toEqual(["request", "reconcile"]);
  });

  it("送る直前の確かめで、求めてから決めた時間を過ぎていれば、DELETE を送らずに失敗として記録する", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const confirmToken = await confirmTokenOf();
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const { requestId, answer, release } = await pausedDelete(confirmToken);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 3 * 60_000);
      release();
      expect((await answer).status).toBe(409);
    } finally {
      vi.useRealTimers();
    }
    expect(spy).not.toHaveBeenCalled();
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome, detailOf(r).refused])).toEqual([
      ["request", "success", undefined],
      ["result", "failed", "stale"],
    ]);
  });

  it("Orthanc が断れば（受けなかったと分かる答え）、消えていないと返し、答えの要点を記録する", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { BackendError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "deleteStudy").mockRejectedValueOnce(new BackendError("画像サーバーの応答が 500"));
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "試験" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ requestId, outcome: "failed" });
    expect(detailOf((await rowsOf(requestId)).at(-1))).toMatchObject({ phase: "result", message: "画像サーバーの応答が 500" });
    expect(await listed()).toBe(true);
  });

  it("消す直前の読み直しができなければ、消さずに失敗として記録する", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { BackendError } = await import("@/lib/backend/types");
    const backend = getBackend();
    const confirmToken = await confirmTokenOf();
    const real = backend.lookupStudyIds.bind(backend);
    let calls = 0;
    vi.spyOn(backend, "lookupStudyIds").mockImplementation(async (uid) => {
      calls += 1;
      if (calls >= 2) throw new BackendError("画像サーバーの応答が 503");
      return real(uid);
    });
    const spy = vi.spyOn(backend, "deleteStudy");
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験", confirmToken })).status).toBe(502);
    expect(spy).not.toHaveBeenCalled();
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome, detailOf(r).refused])).toEqual([
      ["request", "success", undefined],
      ["result", "failed", "reread_failed"],
    ]);
  });

  it("消す前の記録ができなければ消さない", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const session = await import("@/lib/auth/session");
    vi.spyOn(session, "auditIf").mockRejectedValueOnce(new Error("記録の失敗"));
    expect((await del({ requestId: crypto.randomUUID(), reason: "試験" })).status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
    expect(await listed()).toBe(true);
  });

  it("別の Origin・検証モードの書き込みの止め・無い検査は断る", async () => {
    state.role = "admin";
    expect((await del({ requestId: crypto.randomUUID(), reason: "試験" }, "https://attacker.example.org")).status).toBe(403);
    state.config!.auth.devAllowWrite = false;
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験" })).status).toBe(403);
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "dev_write_blocked" });
    state.config!.auth.devAllowWrite = true;
    // 無い検査：確かめの画面は 404 で token を出さない。token が正しくても、引いて無ければ 404
    expect((await preview("1.2.3")).status).toBe(404);
    const { signDeleteConfirm } = await import("@/lib/pacs-ops");
    const confirmToken = signDeleteConfirm(
      { orthancId: "00000000-00000000-00000000-00000000-0000000b", studyInstanceUid: "1.2.3", patientId: "X", version: "v", actorId: "dev" },
      state.config!.sessionSecret,
    );
    expect((await del({ requestId: crypto.randomUUID(), reason: "試験", confirmToken }, ORIGIN, "1.2.3")).status).toBe(404);
    expect(await listed()).toBe(true);
  });
});

describe("削除：違う検査を消さない", () => {
  it("確かめの画面は、Orthanc から読み直した要点と、見せた検査を結んだ token を返し、開いたことを記録する", async () => {
    state.role = "admin";
    const res = await preview();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ patientId: "JP-TEST-0004", patientName: "試験 髙子", studyDate: "20260410", seriesCount: 1, instanceCount: 4 });
    // 要約の生年月日・性別は、一覧の行の値でなく Orthanc から読み直した値
    expect(body).toMatchObject({ patientBirthDate: "19600715", patientSex: "F" });
    const { openDeleteConfirm } = await import("@/lib/pacs-ops");
    const { getBackend } = await import("@/lib/backend");
    const id = (await getBackend().lookupStudy(STUDY))!;
    const info = (await getBackend().studyInfo(id))!;
    expect(openDeleteConfirm(body.confirmToken, state.config!.sessionSecret)).toMatchObject({
      orthancId: id,
      studyInstanceUid: STUDY,
      patientId: "JP-TEST-0004",
      version: info.version,
    });
    // token は暗号化してあり、中身（患者 ID）がそのまま読めない
    expect(body.confirmToken).not.toContain("JP-TEST");
    expect(detailOf(await lastAudit("view_study"))).toMatchObject({ via: "delete_preview" });
    state.role = "general";
    expect((await preview()).status).toBe(403);
  });

  it("確かめの token が無効（書き換え・期限切れ・別の利用者・別の検査）なら、消さずに断る", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { signDeleteConfirm } = await import("@/lib/pacs-ops");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const good = await confirmTokenOf();
    const id = (await getBackend().lookupStudy(STUDY))!;
    const info = (await getBackend().studyInfo(id))!;
    const base = { orthancId: id, studyInstanceUid: STUDY, patientId: info.patientId, version: info.version };
    const secret = state.config!.sessionSecret;
    const tokens = {
      tampered: `${good.slice(0, -4)}AAAA`,
      otherUser: signDeleteConfirm({ ...base, actorId: "someone-else" }, secret),
      otherStudy: signDeleteConfirm({ ...base, studyInstanceUid: "1.2.826.0.1.3680043.8.498.999", actorId: "dev" }, secret),
      otherSecret: signDeleteConfirm({ ...base, actorId: "dev" }, "x".repeat(48)),
    };
    for (const [name, confirmToken] of Object.entries(tokens)) {
      const requestId = crypto.randomUUID();
      expect((await del({ requestId, reason: "試験", confirmToken })).status, name).toBe(409);
      expect(detailOf((await rowsOf(requestId))[0]), name).toMatchObject({ reason: "confirm_invalid" });
    }
    // 用途の違う token（送るの仕事の token）は、確かめの token として開けない。逆も同じ
    const { signJobToken, openJobToken, openDeleteConfirm } = await import("@/lib/pacs-ops");
    const job = signJobToken(
      { jobId: "0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e", requestId: crypto.randomUUID(), studyInstanceUid: STUDY, modality: "dtg", actorId: "dev" },
      secret,
    );
    expect(openDeleteConfirm(job, secret)).toBeNull();
    expect(openJobToken(good, secret)).toBeNull();
    expect((await del({ requestId: crypto.randomUUID(), reason: "試験", confirmToken: job })).status).toBe(409);
    // 期限（10 分）が過ぎた token
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    expect((await del({ requestId: crypto.randomUUID(), reason: "試験", confirmToken: good })).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
  });

  it("確かめの後に、同じ UID・同じ版の別の患者の検査に入れ替わったら、消さずに断る（Orthanc の中の ID と患者 ID で見分ける）", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const backend = getBackend();
    const confirmToken = await confirmTokenOf();
    const real = (await backend.studyInfo((await backend.lookupStudy(STUDY))!))!;
    const swapped = { ...real, orthancId: "00000000-00000000-00000000-00000000-0000000a", patientId: "JP-TEST-0001", patientName: "山田^太郎" };
    vi.spyOn(backend, "lookupStudyIds").mockResolvedValue([swapped.orthancId]);
    vi.spyOn(backend, "studyInfo").mockResolvedValue(swapped);
    const spy = vi.spyOn(backend, "deleteStudy");
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "試験", confirmToken });
    expect(res.status).toBe(409);
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "changed", changed: ["orthancId", "patientId"] });
    expect(spy).not.toHaveBeenCalled();
  });

  it("「求めた」を記録した後、消す直前に別の患者の検査に入れ替わっていても、消さずに失敗として記録する", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const backend = getBackend();
    const confirmToken = await confirmTokenOf();
    const realId = (await backend.lookupStudy(STUDY))!;
    const real = (await backend.studyInfo(realId))!;
    const swapped = { ...real, orthancId: "00000000-00000000-00000000-00000000-0000000a", patientId: "JP-TEST-0001" };
    let calls = 0;
    vi.spyOn(backend, "lookupStudyIds").mockImplementation(async () => (++calls >= 2 ? [swapped.orthancId] : [realId]));
    vi.spyOn(backend, "studyInfo").mockImplementation(async (id) => (id === realId ? real : swapped));
    const spy = vi.spyOn(backend, "deleteStudy");
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験", confirmToken })).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome, detailOf(r).refused])).toEqual([
      ["request", "success", undefined],
      ["result", "failed", "changed"],
    ]);
  });

  it("同じ UID の検査が Orthanc に2つある（患者違いなど）ときは、どちらも消さずに断り、記録する", async () => {
    state.role = "admin";
    const { duplicateMockStudy } = await import("@/lib/backend/mock");
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const confirmToken = await confirmTokenOf();
    duplicateMockStudy(STUDY);
    expect((await preview()).status).toBe(409);
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "試験", confirmToken });
    expect(res.status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    expect(await rowsOf(requestId)).toHaveLength(1);
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "ambiguous", count: 2 });
    // 送る・書き出しも、どれかを選んで書かない
    expect((await exportZip()).status).toBe(409);
  });

  it("引いた検査の UID が求めた UID と合わなければ、消さずに断る", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const backend = getBackend();
    const confirmToken = await confirmTokenOf();
    const real = backend.studyInfo.bind(backend);
    vi.spyOn(backend, "studyInfo").mockImplementation(async (id) => {
      const info = await real(id);
      return info && { ...info, studyInstanceUid: "1.2.826.0.1.3680043.8.498.999" };
    });
    const spy = vi.spyOn(backend, "deleteStudy");
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験", confirmToken })).status).toBe(409);
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "mismatch" });
    expect(spy).not.toHaveBeenCalled();
    // 書き出しも、合わない検査を落とさない
    const exportSpy = vi.spyOn(backend, "exportStudy");
    expect((await exportZip()).status).toBe(409);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("確かめの画面を出した後に検査が変わったら（版が違えば）、消さずに 409", async () => {
    state.role = "admin";
    const confirmToken = await confirmTokenOf();
    const { touchMockStudy } = await import("@/lib/backend/mock");
    const { getBackend } = await import("@/lib/backend");
    touchMockStudy((await getBackend().lookupStudy(STUDY))!);
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "試験", confirmToken });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("検査が更新されました");
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "changed", changed: ["version"] });
    expect(spy).not.toHaveBeenCalled();
    expect(await listed()).toBe(true);
  });

  it("「求めた」を記録した後、消す直前の読み直しで検査が替わっていれば、消さずに失敗として記録する", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const backend = getBackend();
    const confirmToken = await confirmTokenOf();
    const real = backend.studyInfo.bind(backend);
    let calls = 0;
    vi.spyOn(backend, "studyInfo").mockImplementation(async (id) => {
      const info = await real(id);
      calls += 1;
      // 2 回目（消す直前の読み直し）だけ、版が替わった形
      return info && (calls >= 2 ? { ...info, version: "changed-later" } : info);
    });
    const spy = vi.spyOn(backend, "deleteStudy");
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験", confirmToken })).status).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome, detailOf(r).refused])).toEqual([
      ["request", "success", undefined],
      ["result", "failed", "changed"],
    ]);
    expect(await listed()).toBe(true);
  });

  it("本文の Orthanc の ID・患者 ID は使わない（消すのは URL の UID から引いた検査だけ）", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const other = "fd432ba4-73bbd221-afb64d63-c4822c63-b059de02";
    const res = await del({ requestId: crypto.randomUUID(), reason: "試験", orthancId: other, patientId: "JP-TEST-0001" });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledWith("3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("HL7 の管理者による照らし合わせ", () => {
  const resolveHl7 = async (body: unknown, origin = ORIGIN) => {
    const { POST } = await import("@/app/api/hl7/resolve/route");
    return POST(new Request(`${ORIGIN}/api/hl7/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: new URL(ORIGIN).host },
      body: JSON.stringify(body)
    }));
  };
  it("一般は断り、断ったことを記録する", async () => {
    state.role = "general";
    const writeId = crypto.randomUUID();
    expect((await resolveHl7({ writeId, note: "試験" })).status).toBe(403);
    expect(detailOf(await lastAudit("hl7"))).toMatchObject({ writeId, permission: "pacs.reconcile", reason: "forbidden" });
  });
  it("別 Origin を断り、確認内容は必須", async () => {
    state.role = "admin";
    expect((await resolveHl7({ writeId: crypto.randomUUID(), note: "試験" }, "https://attacker.example")).status).toBe(403);
    expect((await resolveHl7({ writeId: crypto.randomUUID(), note: "" })).status).toBe(400);
  });
  it("管理者は画像を読み直して manual の記録だけを足す", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { appendAudit } = await import("@/lib/audit");
    const backend = getBackend();
    const id = (await backend.lookupStudyIds(STUDY))[0]!;
    const tags = await backend.studyInstanceTags(id);
    const writeId = crypto.randomUUID();
    await appendAudit(await db(), {
      actorId: "hl7-receiver",
      actorRole: "system",
      authMode: "hl7",
      action: "hl7",
      outcome: "success",
      studyInstanceUid: STUDY,
      detail: {
        event: "request",
        writeId,
        messageId: crypto.randomUUID(),
        oldOrthancId: id,
        StudyInstanceUID: STUDY,
        before: tags,
        after: tags
      }
    });
    // 仕事の ID が無い要求は、人が確かめるまでは次の受信も止める（design.md §10）。
    const { processMessage } = await import("@/lib/hl7/apply");
    const { readFileSync } = await import("node:fs");
    const message = readFileSync("tests/fixtures/hl7/a08.hl7", "utf8");
    const options = { issuer: "RIS_EMU", allowWrite: true };
    const beforeResolve = await processMessage(Buffer.from(message), "192.0.2.1", backend, undefined, options);
    expect(beforeResolve).toContain("MSA|AE|");
    const modify = vi.spyOn(backend, "modifyStudyKeepingUids");
    const read = vi.spyOn(backend, "studyInstanceTags");
    expect((await resolveHl7({ writeId, note: "Orthanc の仕事とログで処理が終わったことを確認した（試験）" })).status).toBe(200);
    expect(modify).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalled();
    expect(detailOf(await lastAudit("hl7"))).toMatchObject({ event: "reconcile", writeId, manual: true, matchesAfter: true });
    const nextMessage = message.replace("20261024201531A08A", "AFTER-MANUAL");
    expect(nextMessage).not.toBe(message);
    expect(await processMessage(Buffer.from(nextMessage), "192.0.2.1", backend, undefined, options)).toContain("MSA|AA|");
    expect((await resolveHl7({ writeId, note: "再度" })).status).toBe(409);
  });
});
