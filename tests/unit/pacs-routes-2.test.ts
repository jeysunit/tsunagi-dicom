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
  state.config!.auth.devAllowWrite = true;
  vi.restoreAllMocks();
});
afterEach(async () => {
  // 試験が残した結果不明の削除を、猶予の後として照らして片付ける（次の試験が「結果の分からない削除がある」で断られないように）
  vi.restoreAllMocks();
  const { unresolvedRequests } = await import("@/lib/pacs-ops");
  const pending = await unresolvedRequests(await db(), "delete", STUDY, () => true);
  if (pending.length > 0) {
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    state.role = "admin";
    for (const id of pending) await delStatus(id);
    vi.restoreAllMocks();
  }
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
async function rowsOf(requestId: string) {
  return (await db()).auditLog.findMany({ where: { action: "delete", detail: { contains: requestId } }, orderBy: { seq: "asc" } });
}

async function exportZip(headers: Record<string, string> = { "sec-fetch-site": "same-origin" }, uid = STUDY) {
  const { GET } = await import("@/app/api/studies/[uid]/export/route");
  return GET(new Request(`${ORIGIN}/api/studies/${uid}/export`, { headers }), uidParams(uid));
}
/** いまの検査の版（確かめの画面で見せる版の代わり。Orthanc から直に読む） */
async function versionOf(uid = STUDY): Promise<string> {
  const { getBackend } = await import("@/lib/backend");
  const ids = await getBackend().lookupStudyIds(uid);
  const info = ids.length === 1 ? await getBackend().studyInfo(ids[0]!) : null;
  return info?.version ?? "no-version";
}
/** 削除を求める。本文に version が無ければ、いまの版を添える（確かめの画面を通った形） */
async function del(body: Record<string, unknown>, origin = ORIGIN, uid = STUDY) {
  const { POST } = await import("@/app/api/studies/[uid]/delete/route");
  const withVersion = "version" in body ? body : { ...body, version: await versionOf(uid) };
  return POST(
    new Request(`${ORIGIN}/api/studies/${uid}/delete`, {
      method: "POST",
      headers: { "content-type": "application/json", origin, host: new URL(ORIGIN).host },
      body: JSON.stringify(withVersion),
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
  return (await getBackend().searchStudies()).some((s) => s.studyInstanceUid === uid);
}

describe("書き出し（ZIP）", () => {
  it("管理者・医師・技師は落とせ、落とす前に記録する。ファイルの名前に患者の情報を入れない", async () => {
    for (const role of ["admin", "doctor", "technologist"]) {
      state.role = role;
      const res = await exportZip();
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
      const disposition = res.headers.get("content-disposition") ?? "";
      expect(disposition).toMatch(/^attachment; filename="study-[0-9a-f]{8}\.zip"$/);
      expect(disposition).not.toMatch(/JP-TEST|1\.2\.826/);
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      expect(await lastAudit("export")).toMatchObject({ outcome: "success", actorRole: role, patientId: "JP-TEST-0004", studyInstanceUid: STUDY });
    }
  });

  it("閲覧には断り、断ったことを記録する", async () => {
    state.role = "viewer";
    expect((await exportZip()).status).toBe(403);
    expect(await lastAudit("export")).toMatchObject({ outcome: "denied", actorRole: "viewer" });
  });

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
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "success"],
    ]);
    expect(rows[0]).toMatchObject({ actorRole: "admin", patientId: "JP-TEST-0004", studyInstanceUid: STUDY });
    expect(detailOf(rows[0])).toMatchObject({ reason: "取り違えた検査（試験）", series: 1, instances: 4 });
    // 消えた検査は、受け取りの記録・引き当てにも出ない
    const { getBackend } = await import("@/lib/backend");
    expect(await getBackend().lookupStudy(STUDY)).toBeNull();
    expect((await getBackend().receivedStudies(100)).studies.some((r) => r.summary.studyInstanceUid === STUDY)).toBe(false);
  });

  it("管理者のほかの役割には断り、Orthanc を呼ばずに、断ったことを記録する", async () => {
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    for (const role of ["doctor", "technologist", "viewer"]) {
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
    // 求めてからすぐは、Orthanc が消している途中かもしれないので確定させない（記録に足さない）
    const early = await delStatus(requestId);
    expect(early.status).toBe(202);
    expect(await early.json()).toMatchObject({ requestId, outcome: "unknown", studyPresent: true });
    expect((await rowsOf(requestId)).at(-1)).toMatchObject({ outcome: "unknown" });
    // 結果不明の間は、同じ検査の削除を新しい要求の ID でも断る
    const blocked = await del({ requestId: crypto.randomUUID(), reason: "試験" });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).pendingRequestIds).toEqual([requestId]);
    // 猶予（10 分）の後もまだあれば、「消えていない」と確定する
    const later = Date.now() + 11 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect(await (await delStatus(requestId)).json()).toEqual({ requestId, outcome: "not_deleted", reconciled: true });
    expect((await rowsOf(requestId)).at(-1)).toMatchObject({ outcome: "failed" });
  });

  it("結果不明の削除を、技師は照らせない（管理者は照らせる）", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(getBackend(), "deleteStudy").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    await del({ requestId, reason: "試験" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    state.role = "technologist";
    expect((await delStatus(requestId)).status).toBe(403);
    state.role = "admin";
    expect(await (await delStatus(requestId)).json()).toMatchObject({ outcome: "not_deleted", reconciled: true });
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
    const version = await versionOf();
    const real = backend.lookupStudyIds.bind(backend);
    let calls = 0;
    vi.spyOn(backend, "lookupStudyIds").mockImplementation(async (uid) => {
      calls += 1;
      if (calls >= 2) throw new BackendError("画像サーバーの応答が 503");
      return real(uid);
    });
    const spy = vi.spyOn(backend, "deleteStudy");
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験", version })).status).toBe(502);
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
    expect((await del({ requestId: crypto.randomUUID(), reason: "試験" }, ORIGIN, "1.2.3")).status).toBe(404);
    expect(await listed()).toBe(true);
  });
});

describe("削除：違う検査を消さない", () => {
  it("確かめの画面は、Orthanc から読み直した要点と版を返し、開いたことを記録する", async () => {
    state.role = "admin";
    const res = await preview();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ patientId: "JP-TEST-0004", patientName: "試験 髙子", studyDate: "20260410", seriesCount: 1, instanceCount: 4 });
    expect(body.version).toBe(await versionOf());
    expect(detailOf(await lastAudit("view_study"))).toMatchObject({ via: "delete_preview" });
    state.role = "technologist";
    expect((await preview()).status).toBe(403);
  });

  it("同じ UID の検査が Orthanc に2つある（患者違いなど）ときは、どちらも消さずに断り、記録する", async () => {
    state.role = "admin";
    const { duplicateMockStudy } = await import("@/lib/backend/mock");
    const { getBackend } = await import("@/lib/backend");
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    duplicateMockStudy(STUDY);
    expect((await preview()).status).toBe(409);
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "試験", version: "anything" });
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
    const real = backend.studyInfo.bind(backend);
    vi.spyOn(backend, "studyInfo").mockImplementation(async (id) => {
      const info = await real(id);
      return info && { ...info, studyInstanceUid: "1.2.826.0.1.3680043.8.498.999" };
    });
    const spy = vi.spyOn(backend, "deleteStudy");
    const requestId = crypto.randomUUID();
    expect((await del({ requestId, reason: "試験", version: "x" })).status).toBe(409);
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "mismatch" });
    expect(spy).not.toHaveBeenCalled();
    // 書き出しも、合わない検査を落とさない
    const exportSpy = vi.spyOn(backend, "exportStudy");
    expect((await exportZip()).status).toBe(409);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("確かめの画面を出した後に検査が変わったら（版が違えば）、消さずに 409", async () => {
    state.role = "admin";
    const shown = (await (await preview()).json()).version as string;
    const { touchMockStudy } = await import("@/lib/backend/mock");
    const { getBackend } = await import("@/lib/backend");
    touchMockStudy((await getBackend().lookupStudy(STUDY))!);
    const spy = vi.spyOn(getBackend(), "deleteStudy");
    const requestId = crypto.randomUUID();
    const res = await del({ requestId, reason: "試験", version: shown });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("検査が変わった");
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "changed", shown });
    expect(spy).not.toHaveBeenCalled();
    expect(await listed()).toBe(true);
  });

  it("「求めた」を記録した後、消す直前の読み直しで検査が替わっていれば、消さずに失敗として記録する", async () => {
    state.role = "admin";
    const { getBackend } = await import("@/lib/backend");
    const backend = getBackend();
    const version = await versionOf();
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
    expect((await del({ requestId, reason: "試験", version })).status).toBe(409);
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
