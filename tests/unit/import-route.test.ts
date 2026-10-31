import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { dicomFile } from "./helpers/dicom-file";
import { testDatabases } from "./helpers/test-db";

// 段 6 のインポート（docs/spec.md の 3.5 の「取り込み」）を、検証モード（AUTH_MODE=dev。モックの Orthanc）のセッションから通して確かめる。
// 大きさの上限と DICOM でないものを Orthanc へ渡す前に断る、断ったことも記録に残る、呼ぶ前と後の監査の行（要求の ID で結ぶ）、
// 同じ要求の ID を二度流さない、結果不明と照らし合わせ、CSRF（Origin）、検証モードの書き込みの止め、
// インポートした検査が検査一覧で分かる（imported）を見る。

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

// モックの見本の検査（tests/fixtures/orthanc）。モックはこの UID のファイルだけを受ける
const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-import-route-");

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
  state.config!.auth.devAllowWrite = true;
  vi.restoreAllMocks();
  const { restoreMockStudies } = await import("@/lib/backend/mock");
  restoreMockStudies();
});

let sop = 100;
const nextSop = () => `1.2.826.0.1.3680043.8.498.9${sop++}`;

function upload(body: Uint8Array, requestId: string = crypto.randomUUID(), origin = ORIGIN, extra: Record<string, string> = {}) {
  return new Request(`${ORIGIN}/api/import`, {
    method: "POST",
    headers: { "content-type": "application/dicom", origin, host: new URL(ORIGIN).host, "x-request-id": requestId, ...extra },
    body: body as Uint8Array<ArrayBuffer>,
  });
}
async function post(body: Uint8Array, requestId?: string, origin?: string, extra?: Record<string, string>) {
  const { POST } = await import("@/app/api/import/route");
  return POST(upload(body, requestId, origin, extra));
}
async function status(requestId: string) {
  const { GET } = await import("@/app/api/import/route");
  return GET(new Request(`${ORIGIN}/api/import?requestId=${requestId}`));
}
async function db() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}
async function rowsOf(requestId: string) {
  return (await db()).auditLog.findMany({ where: { action: "import", detail: { contains: requestId } }, orderBy: { seq: "asc" } });
}
const detailOf = (row: { detail: string | null } | undefined | null) => JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;
async function listAll() {
  const { GET } = await import("@/app/api/studies/route");
  const res = await GET(new Request(`${ORIGIN}/api/studies?date=all`));
  return ((await res.json()) as { studies: { studyInstanceUid: string; imported?: boolean }[] }).studies;
}
const listed = async (uid: string) => (await listAll()).find((s) => s.studyInstanceUid === uid);

describe("インポート", () => {
  it("一般は DICOM のファイルを入れられ、呼ぶ前と後の行が要求の ID で結ばれ、検査一覧で「インポート」と分かる", async () => {
    // 見本の検査を消してから入れ直す（モックは見本の検査のファイルだけを受ける）
    const { createMockBackend } = await import("@/lib/backend/mock");
    const backend = createMockBackend();
    await backend.deleteStudy((await backend.lookupStudy(STUDY))!);
    expect(await listed(STUDY)).toBeUndefined();

    const requestId = crypto.randomUUID();
    const batch = crypto.randomUUID();
    const sopUid = nextSop();
    const file = dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: "JP-TEST-0001" });
    const res = await post(file, requestId, ORIGIN, { "x-import-batch": batch, "x-import-index": "1", "x-import-total": "3" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requestId, outcome: "stored", studyInstanceUid: STUDY, labeled: true });

    const rows = await rowsOf(requestId);
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "success"],
    ]);
    expect(rows[0]).toMatchObject({ actorRole: "general", patientId: "JP-TEST-0001", studyInstanceUid: STUDY });
    expect(detailOf(rows[0])).toMatchObject({
      bytes: file.byteLength,
      sopInstanceUid: sopUid,
      transferSyntaxUid: "1.2.840.10008.1.2.1",
      batch: { id: batch, index: 1, total: 3 },
    });
    expect(detailOf(rows[1])).toMatchObject({ status: "Success", labeled: true });
    expect(await listed(STUDY)).toMatchObject({ imported: true });
  });

  it("同じ画像をもう一度入れると「もうあった」で、印は付け直さない。インポートしていない検査には印が無い", async () => {
    const sopUid = nextSop();
    const file = dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid });
    expect((await (await post(file)).json()).outcome).toBe("stored");
    const again = await post(file);
    expect(await again.json()).toMatchObject({ outcome: "already", labeled: false });
    const studies = await listAll();
    expect(studies.length).toBeGreaterThan(1);
    expect(studies.filter((s) => s.imported).map((s) => s.studyInstanceUid)).toEqual([STUDY]);
    expect(studies.every((s) => typeof s.imported === "boolean")).toBe(true);
  });

  it("同じ要求の ID を二度送っても、Orthanc を呼び直さない", async () => {
    const requestId = crypto.randomUUID();
    const file = dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop() });
    expect((await post(file, requestId)).status).toBe(200);
    const { getBackend } = await import("@/lib/backend");
    const call = vi.spyOn(getBackend(), "importInstance");
    const second = await post(file, requestId);
    expect(call).not.toHaveBeenCalled();
    expect(await second.json()).toMatchObject({ requestId, outcome: "stored", repeated: true });
    expect((await rowsOf(requestId)).filter((r) => detailOf(r).phase === "request")).toHaveLength(1);
  });

  it("同じ要求の ID で同じ検査の別の画像を送ると、前の結果を返さずに 409（画像を抜かさない）", async () => {
    const requestId = crypto.randomUUID();
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop() }), requestId)).status).toBe(200);
    const { getBackend } = await import("@/lib/backend");
    const call = vi.spyOn(getBackend(), "importInstance");
    const other = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop() }), requestId);
    expect(other.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
  });

  it("大きさの上限を超えたファイルは、Orthanc へ渡す前に 413 で断り、断ったことを記録する", async () => {
    const requestId = crypto.randomUUID();
    const big = new Uint8Array(1024 * 1024 + 1);
    big.set(dicomFile({ studyInstanceUid: STUDY }));
    const res = await post(big, requestId);
    expect(res.status).toBe(413);
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
    expect(detailOf(rows[0])).toMatchObject({ reason: "too_large", maxMb: 1 });
  });

  it.each([
    ["DICM の無いファイル", dicomFile({ studyInstanceUid: STUDY, noMagic: true }), "not_dicom"],
    ["ZIP", new TextEncoder().encode("PK\u0003\u0004".padEnd(200, "x")), "not_dicom"],
    ["Deflated の転送構文", dicomFile({ studyInstanceUid: STUDY, transferSyntaxUid: "1.2.840.10008.1.2.1.99" }), "unsupported_transfer_syntax"],
  ])("%s は Orthanc へ渡す前に 400 で断り、断ったことを記録する", async (_, body, reason) => {
    const requestId = crypto.randomUUID();
    const res = await post(body, requestId);
    expect(res.status).toBe(400);
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
    expect(detailOf(rows[0])).toMatchObject({ reason });
  });

  it("別の画面からの要求（Origin が違う）は 403 で、何も記録しない", async () => {
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY }), requestId, "http://evil.example.org");
    expect(res.status).toBe(403);
    expect(await rowsOf(requestId)).toHaveLength(0);
  });

  it("要求の ID が無い・正しくない要求は 400", async () => {
    expect((await post(dicomFile({ studyInstanceUid: STUDY }), "not-a-uuid")).status).toBe(400);
  });

  it("検証モードで書き込みが無効なら 403 で断り、断ったことを記録する", async () => {
    state.config!.auth.devAllowWrite = false;
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY }), requestId);
    expect(res.status).toBe(403);
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
    expect(detailOf(rows[0])).toMatchObject({ reason: "dev_write_blocked" });
  });

  it("Orthanc が受けなかったファイルは、失敗を記録する", async () => {
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: "1.2.826.0.1.3680043.8.498.777" }), requestId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "failed"],
    ]);
  });

  it("答えが分からなければ結果不明で、状態の確認で SOP Instance UID を引き当てて照らす", async () => {
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop() }), requestId);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ requestId, outcome: "unknown" });
    simulateMockImport({});
    const checked = await status(requestId);
    expect(await checked.json()).toMatchObject({ requestId, outcome: "stored", reconciled: true });
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "unknown"],
      ["reconcile", "success"],
    ]);
  });

  it("入ったと読めない結果不明は、照らしても結果不明のまま（失敗と確定しない）", async () => {
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop() }), requestId);
    const { restoreMockStudies } = await import("@/lib/backend/mock");
    restoreMockStudies();
    const checked = await status(requestId);
    expect(checked.status).toBe(202);
    expect(await checked.json()).toMatchObject({ outcome: "unknown" });
  });
});
