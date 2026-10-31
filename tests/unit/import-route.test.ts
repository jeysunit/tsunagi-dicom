import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { dicomFile } from "./helpers/dicom-file";
import { testDatabases } from "./helpers/test-db";

// 段 6 のインポート（docs/spec.md の 3.5 の「取り込み」）を、検証モード（AUTH_MODE=dev。モックの Orthanc）のセッションから通して確かめる。
// 大きさの上限と DICOM でないものを Orthanc へ渡す前に断る、断ったことも記録に残る、呼ぶ前と後の監査の行（要求の ID で結ぶ）、
// 同じ要求の ID を二度流さない、結果不明と照らし合わせ、CSRF（Origin）、検証モードの書き込みの止め、
// インポートした検査が検査一覧で分かる（imported）を見る。
// もうある画像・検査の取り込み直しを断る（同じ組の続きの画像は通す）、同じ検査に結果の分からない取り込み・削除・修正が
// あれば断る、Orthanc が保存した値がファイルの値と違えば入れた画像を消して断る、も見る。

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

// モックの見本の検査（tests/fixtures/orthanc）。モックはこれらの UID のファイルだけを受け、保存した値は見本の値（患者 ID）になる。
// 記録は試験の間で消えないので、結果の分からない要求を残す試験は、ほかの試験と別の検査を使う
const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const PATIENT = "JP-TEST-0004";
const STUDY_LEFT_UNKNOWN = "1.2.826.0.1.3680043.8.498.45255015335478509141706689498950755880";
const STUDY_HL7 = "1.2.826.0.1.3680043.8.498.12421290802828275301475531919530615941";
const STUDY_DELETE = "1.2.826.0.1.3680043.8.498.74370219478963110549339491256573063606";
const STUDY_MODIFY = "1.2.826.0.1.3680043.8.498.92586672124270452901721343807821604204";
const STUDY_BLOCKED = "1.2.826.0.1.3680043.8.498.73812431209939638312153431926357964288";
const STUDY_HL7_MANUAL = "1.2.826.0.1.3680043.8.498.75667752445432888498174554407272599978";
const STUDY_GET_MISMATCH = "1.2.826.0.1.3680043.8.498.12580196157444326238324642149044327503";
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
async function backend() {
  const { getBackend } = await import("@/lib/backend");
  return getBackend();
}
/** 見本の検査を消す（モックは見本の検査のファイルだけを受け、もうある検査への取り込みは断られるので、消してから入れ直す） */
async function removeStudy(uid: string) {
  const b = await backend();
  await b.deleteStudy((await b.lookupStudy(uid))!);
}
/** 試験のために、記録に別の操作の行を足す（試験の利用者の名前で） */
async function record(action: "hl7" | "delete" | "modify", uid: string, outcome: "success" | "unknown", detail: Record<string, unknown>) {
  const { appendAudit } = await import("@/lib/audit");
  await appendAudit(await db(), { actorId: "test", actorRole: "admin", authMode: "dev", action, outcome, studyInstanceUid: uid, detail });
}
/**
 * 並んで届いた別の取り込み（同じ利用者・別の要求の ID）の「求めた」と結果の行を、STUDY に足す。結果の行（失敗）も足すので、
 * 解けていない要求としては残らない（後の試験を止めない）
 */
async function startedImport(extra: Record<string, unknown>, studyInstanceUid = STUDY) {
  const { appendAudit } = await import("@/lib/audit");
  const requestId = crypto.randomUUID();
  for (const [phase, outcome] of [["request", "success"], ["result", "failed"]] as const) {
    await appendAudit(await db(), {
      actorId: "dev",
      actorRole: "general",
      authMode: "dev",
      action: "import",
      outcome,
      patientId: PATIENT,
      studyInstanceUid,
      detail: { requestId, ...extra, phase },
    });
  }
}
const batchHeaders = (id: string, index: number, total: number) => ({ "x-import-batch": id, "x-import-index": String(index), "x-import-total": String(total) });

describe("インポート", () => {
  it("一般は DICOM のファイルを入れられ、呼ぶ前と後の行が要求の ID で結ばれ、検査一覧で「インポート」と分かる", async () => {
    await removeStudy(STUDY);
    expect(await listed(STUDY)).toBeUndefined();

    const requestId = crypto.randomUUID();
    const batch = crypto.randomUUID();
    const sopUid = nextSop();
    const file = dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT });
    const res = await post(file, requestId, ORIGIN, batchHeaders(batch, 1, 3));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requestId, outcome: "stored", studyInstanceUid: STUDY, labeled: true });

    const rows = await rowsOf(requestId);
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "success"],
    ]);
    expect(rows[0]).toMatchObject({ actorRole: "general", patientId: PATIENT, studyInstanceUid: STUDY });
    expect(detailOf(rows[0])).toMatchObject({
      bytes: file.byteLength,
      sopInstanceUid: sopUid,
      transferSyntaxUid: "1.2.840.10008.1.2.1",
      batch: { id: batch, index: 1, total: 3 },
    });
    expect(detailOf(rows[1])).toMatchObject({ status: "Success", labeled: true, orthancInstanceId: expect.any(String) });
    expect(await listed(STUDY)).toMatchObject({ imported: true });
    const studies = await listAll();
    expect(studies.filter((s) => s.imported).map((s) => s.studyInstanceUid)).toEqual([STUDY]);
  });

  it("同じ画像（SOP Instance UID）をもう一度入れると、Orthanc へ渡さずに 409 で断り、断ったことを記録する", async () => {
    await removeStudy(STUDY);
    const file = dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT });
    const batch = crypto.randomUUID();
    expect((await (await post(file, undefined, ORIGIN, batchHeaders(batch, 1, 2))).json()).outcome).toBe("stored");
    const call = vi.spyOn(await backend(), "importInstance");
    const requestId = crypto.randomUUID();
    // 同じ組の続きとして送っても、同じ画像は断る
    const again = await post(file, requestId, ORIGIN, batchHeaders(batch, 2, 2));
    expect(again.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    const rows = await rowsOf(requestId);
    expect(rows.map((r) => r.outcome)).toEqual(["denied"]);
    expect(rows[0]).toMatchObject({ patientId: PATIENT, studyInstanceUid: STUDY });
    expect(detailOf(rows[0])).toMatchObject({ reason: "instance_exists" });
  });

  it("もうある検査（StudyInstanceUID）に別の画像を入れると、Orthanc へ渡さずに 409 で断る（取り込み直しで中身を置き換えない）", async () => {
    const call = vi.spyOn(await backend(), "importInstance");
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), requestId);
    expect(res.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "study_exists", orthancStudyId: expect.any(String) });
  });

  it("同じ組で先に入れた検査には、同じ患者 ID の続きの画像を入れられる。別の組・別の患者 ID・組の無い要求は断る", async () => {
    await removeStudy(STUDY);
    const batch = crypto.randomUUID();
    const first = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 1, 3));
    expect(first.status).toBe(200);
    const second = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 2, 3));
    expect(await second.json()).toMatchObject({ outcome: "stored" });

    const call = vi.spyOn(await backend(), "importInstance");
    const otherBatch = await post(
      dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }),
      undefined,
      ORIGIN,
      batchHeaders(crypto.randomUUID(), 1, 1),
    );
    expect(otherBatch.status).toBe(409);
    const otherPatient = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: "JP-TEST-0099" }), undefined, ORIGIN, batchHeaders(batch, 3, 3));
    expect(otherPatient.status).toBe(409);
    const noBatch = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }));
    expect(noBatch.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
  });

  // 同じ組の続きの例外は、同じ利用者が、開いている組で、この検査を新しく作った（createdStudy・Orthanc の答えが Success）
  // 新しい行だけに当てる。もうある見本の検査（STUDY）に、作った行を記録に足して確かめる
  it.each([
    ["例外に当たる行（対照）", {}, {}, 200],
    ["別の利用者の行", { actorId: "someone-else" }, {}, 409],
    ["検査を新しく作った印の無い行", {}, { createdStudy: undefined }, 409],
    ["Orthanc の答えが AlreadyStored の行", {}, { status: "AlreadyStored" }, 409],
    ["閉じた組（何番目 = ファイルの数）の行", {}, { batch: { index: 2, total: 2 } }, 409],
    ["ファイルの数の違う組の行", {}, { batch: { index: 1, total: 3 } }, 409],
    // 結果・照らし合わせの行が新しくても、元の要求の「求めた」が窓の外なら当てない（遅れた照らし合わせで窓を開け直さない）
    ["「求めた」が時間の窓の外の古い要求の行", { occurredAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) }, {}, 409],
    ["照らし合わせの行（例外に当たる）", {}, { phase: "reconcile", status: undefined }, 200],
  ])("同じ組の続きの例外：%s", async (_, row: Record<string, unknown>, change: Record<string, unknown>, expected) => {
    const batch = crypto.randomUUID();
    const orthancStudyId = (await (await backend()).lookupStudy(STUDY))!;
    const detail: Record<string, unknown> = {
      requestId: crypto.randomUUID(),
      phase: "result",
      status: "Success",
      createdStudy: true,
      orthancStudyId,
      ...change,
      batch: { id: batch, index: 1, total: 2, ...(change.batch as object | undefined) },
    };
    if (detail.createdStudy === undefined) delete detail.createdStudy;
    const { appendAudit } = await import("@/lib/audit");
    const common = { actorId: "dev", actorRole: "general", authMode: "dev", action: "import" as const, outcome: "success" as const, patientId: PATIENT, studyInstanceUid: STUDY };
    // 「求めた」の行（時間の窓はこの時刻で測る）と、結果の行（いまの時刻）
    const { occurredAt, ...who } = row as { occurredAt?: Date };
    await appendAudit(await db(), {
      ...common,
      ...who,
      ...(occurredAt ? { occurredAt } : {}),
      detail: { requestId: detail.requestId, batch: detail.batch, sopInstanceUid: nextSop(), newStudy: true, phase: "request" },
    });
    await appendAudit(await db(), { ...common, ...who, detail });
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 2, 2));
    expect(res.status).toBe(expected);
  });

  it("新しく作った検査の結果の行には createdStudy が、続きの画像の行には無い", async () => {
    await removeStudy(STUDY);
    const batch = crypto.randomUUID();
    const first = crypto.randomUUID();
    const second = crypto.randomUUID();
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), first, ORIGIN, batchHeaders(batch, 1, 2))).status).toBe(200);
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), second, ORIGIN, batchHeaders(batch, 2, 2))).status).toBe(200);
    expect(detailOf((await rowsOf(first))[0])).toMatchObject({ newStudy: true });
    expect(detailOf((await rowsOf(first)).at(-1))).toMatchObject({ phase: "result", createdStudy: true });
    expect(detailOf((await rowsOf(second))[0]).newStudy).toBeUndefined();
    expect(detailOf((await rowsOf(second)).at(-1)).createdStudy).toBeUndefined();
  });

  it("終わった組に、使った番目を使い回して画像を足せない（失敗と決まった番目だけは送り直せる）", async () => {
    await removeStudy(STUDY);
    const batch = crypto.randomUUID();
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 1, 3))).status).toBe(200);
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 2, 3))).status).toBe(200);
    const call = vi.spyOn(await backend(), "importInstance");
    const reusedId = crypto.randomUUID();
    const reused = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), reusedId, ORIGIN, batchHeaders(batch, 2, 3));
    expect(reused.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(reusedId))[0])).toMatchObject({ reason: "batch_index_used" });
    call.mockRestore();
    // 3 番目が Orthanc に断られて失敗と決まれば、同じ番目で送り直せる
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ refuse: true });
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 3, 3))).status).toBeGreaterThanOrEqual(400);
    simulateMockImport({});
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 3, 3))).status).toBe(200);
  });

  it("Orthanc が保存した患者 ID がファイルの値と違えば、入れた画像を消して 409 で断り、消す前と消した結果を記録する", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    const real = b.studyInfo.bind(b);
    vi.spyOn(b, "studyInfo").mockImplementation(async (id) => {
      const info = await real(id);
      return info && { ...info, patientId: "JP-TEST-0099" };
    });
    const remove = vi.spyOn(b, "deleteImportedInstance");
    const requestId = crypto.randomUUID();
    const sopUid = nextSop();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT }), requestId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ outcome: "failed", removed: true, mismatched: ["patientId"] });
    expect(remove).toHaveBeenCalledTimes(1);
    const rows = await rowsOf(requestId);
    // 消す前に「消す」の行（要求は解けていないまま）、消えたと読めてから失敗の結果
    expect(rows.map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["cleanup_request", "unknown"],
      ["result", "failed"],
    ]);
    expect(detailOf(rows[1])).toMatchObject({
      reason: "stored_mismatch",
      mismatched: ["patientId"],
      stored: { patientId: "JP-TEST-0099", studyInstanceUid: STUDY, studies: 1 },
      orthancInstanceId: expect.any(String),
    });
    expect(detailOf(rows[2])).toMatchObject({ reason: "stored_mismatch", cleanup: "removed", orthancInstanceId: detailOf(rows[1]).orthancInstanceId });
    // 入れた画像は消え、印も付けない
    expect(await b.findInstanceStudy(sopUid)).toBeNull();
    expect(await listed(STUDY)).toBeUndefined();
    // 同じ要求の ID の状態の確認は、失敗のまま
    expect(await (await status(requestId)).json()).toMatchObject({ outcome: "failed" });
  });

  it("Orthanc が保存した StudyInstanceUID がファイルの値と違っても、入れた画像を消して断る", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    const real = b.studyInfo.bind(b);
    vi.spyOn(b, "studyInfo").mockImplementation(async (id) => {
      const info = await real(id);
      return info && { ...info, studyInstanceUid: "1.2.826.0.1.3680043.8.498.66" };
    });
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ removed: true, mismatched: ["studyInstanceUid"] });
  });

  it("違った画像を消した答えが分からなければ、502 で結果不明とし、画像が消えたと読めるまで要求を解かない", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    const real = b.studyInfo.bind(b);
    vi.spyOn(b, "studyInfo").mockImplementation(async (id) => {
      const info = await real(id);
      return info && { ...info, patientId: "JP-TEST-0099" };
    });
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ deleteUnknown: true });
    const requestId = crypto.randomUUID();
    const sopUid = nextSop();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT }), requestId);
    simulateMockImport({});
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ outcome: "unknown", removed: false });
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome, detailOf(r).cleanup])).toEqual([
      ["request", "success", undefined],
      ["cleanup_request", "unknown", undefined],
      ["result", "unknown", "unknown"],
    ]);
    // 画像が残っているあいだは、状態の確認でも消し直さず、結果不明のまま。同じ検査の取り込みも断る
    const remove = vi.spyOn(b, "deleteImportedInstance");
    expect((await status(requestId)).status).toBe(202);
    expect(remove).not.toHaveBeenCalled();
    await removeStudy(STUDY);
    const blocked = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }));
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ pending: [requestId] });
    // 画像が消えたと読めれば（ここでは検査ごと消えた）、失敗を足して解く。消す画像を ID で名指しで読むので、
    // 同じ SOP Instance UID のほかの画像が複数あっても（SOP Instance UID の引き当てが 409 でも）解ける
    remove.mockRestore();
    const { BackendError } = await import("@/lib/backend/types");
    vi.spyOn(b, "findInstanceStudy").mockRejectedValue(new BackendError("同じ SOP Instance UID の画像が複数あります", 409));
    const solved = await status(requestId);
    expect(await solved.json()).toMatchObject({ outcome: "failed", removed: true, reconciled: true });
    expect((await rowsOf(requestId)).at(-1)).toMatchObject({ outcome: "failed" });
    expect(detailOf((await rowsOf(requestId)).at(-1))).toMatchObject({ phase: "reconcile", cleanup: "removed" });
  });

  it("引き当ての後に、別の要求の ID で同じ画像の取り込みが始まっていれば、記録の並びの中で見つけて断る", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    const sopUid = nextSop();
    const real = b.findInstanceStudy.bind(b);
    // 引き当ての間に、並んで届いた別の取り込みが「求めた」を記録した
    vi.spyOn(b, "findInstanceStudy").mockImplementationOnce(async (sop) => {
      await startedImport({ sopInstanceUid: sopUid });
      return real(sop);
    });
    const call = vi.spyOn(b, "importInstance");
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT }), requestId);
    expect(res.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "instance_exists", raced: true });
  });

  it("引き当ての後に、別の検査（StudyInstanceUID）で同じ SOP Instance UID の取り込みが始まっていても断る", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    const sopUid = nextSop();
    const real = b.findInstanceStudy.bind(b);
    vi.spyOn(b, "findInstanceStudy").mockImplementationOnce(async (sop) => {
      await startedImport({ sopInstanceUid: sopUid }, "1.2.826.0.1.3680043.8.498.555");
      return real(sop);
    });
    const call = vi.spyOn(b, "importInstance");
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT }), requestId);
    expect(res.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "instance_exists", raced: true });
  });

  it("引き当ての前に始まって結果の分からない、別の検査の同じ SOP Instance UID の取り込みがあれば断る", async () => {
    await removeStudy(STUDY);
    const sopUid = nextSop();
    // 別の検査で「求めた」だけがある（Orthanc に入る前かもしれない）取り込み
    const { appendAudit } = await import("@/lib/audit");
    await appendAudit(await db(), {
      actorId: "dev",
      actorRole: "general",
      authMode: "dev",
      action: "import",
      outcome: "success",
      patientId: PATIENT,
      studyInstanceUid: "1.2.826.0.1.3680043.8.498.556",
      detail: { requestId: crypto.randomUUID(), sopInstanceUid: sopUid, phase: "request" },
    });
    const call = vi.spyOn(await backend(), "importInstance");
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT }), requestId);
    expect(res.status).toBe(409);
    expect(call).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "instance_exists", raced: true });
  });

  it("前の同じ SOP Instance UID の取り込みが、SOP Instance UID を持たない照らし合わせの行で解けていれば、止めない", async () => {
    await removeStudy(STUDY);
    const sopUid = nextSop();
    const earlier = crypto.randomUUID();
    const other = "1.2.826.0.1.3680043.8.498.557";
    const { appendAudit } = await import("@/lib/audit");
    for (const [outcome, detail] of [
      ["success", { requestId: earlier, sopInstanceUid: sopUid, phase: "request" }],
      ["unknown", { requestId: earlier, sopInstanceUid: sopUid, phase: "result" }],
      // 照らし合わせの行（前の形。SOP Instance UID を持たない）
      ["success", { requestId: earlier, phase: "reconcile", orthancStudyId: "00000000-00000000-00000000-00000000-00000000" }],
    ] as const) {
      await appendAudit(await db(), { actorId: "dev", actorRole: "general", authMode: "dev", action: "import", outcome, patientId: PATIENT, studyInstanceUid: other, detail });
    }
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: sopUid, patientId: PATIENT }));
    expect(res.status).toBe(200);
  });

  it("取り込んだ後に、同じ SOP Instance UID の画像がほかにもあると読めたら、入れた画像だけを消して断る", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    const real = b.findInstanceStudy.bind(b);
    // 取り込む前の引き当ては無し、取り込んだ後の照らしでは 2 つある（409）
    vi.spyOn(b, "findInstanceStudy")
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(Object.assign(new (await import("@/lib/backend/types")).BackendError("複数", 409)));
    const remove = vi.spyOn(b, "deleteImportedInstance");
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ removed: true, mismatched: ["instanceCount"] });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("引き当ての後に、別の組で同じ検査の取り込みが始まっていれば断る（同じ組の別の画像は通す）", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    const real = b.findInstanceStudy.bind(b);
    const batch = crypto.randomUUID();
    const started = (batchId: string) => async (sop: string) => {
      await startedImport({ sopInstanceUid: nextSop(), batch: { id: batchId, index: 9, total: 9 } });
      return real(sop);
    };
    vi.spyOn(b, "findInstanceStudy").mockImplementationOnce(started(crypto.randomUUID()));
    const other = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 1, 2));
    expect(other.status).toBe(409);
    expect(await other.json()).toMatchObject({ error: expect.any(String) });
    vi.spyOn(b, "findInstanceStudy").mockImplementationOnce(started(batch));
    const sameBatch = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), undefined, ORIGIN, batchHeaders(batch, 1, 2));
    expect(sameBatch.status).toBe(200);
  });

  it("Orthanc が保存した値を読めなければ、成功とせず結果不明にする（印も付けない）", async () => {
    await removeStudy(STUDY);
    const b = await backend();
    vi.spyOn(b, "studyInfo").mockRejectedValue(new Error("読めない"));
    const label = vi.spyOn(b, "labelImported");
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), requestId);
    expect(res.status).toBe(202);
    expect(label).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(requestId)).at(-1))).toMatchObject({ phase: "result", reason: "verify_failed" });
    // 読めるようになれば、状態の確認で照らして成功を足し、印を付ける
    vi.restoreAllMocks();
    expect(await (await status(requestId)).json()).toMatchObject({ outcome: "stored", reconciled: true, labeled: true });
  });

  it("患者 ID を字に直せない（文字の集合が ISO 2022 で ASCII の外の字）ファイルは、Orthanc へ渡す前に 400 で断る", async () => {
    await removeStudy(STUDY);
    const call = vi.spyOn(await backend(), "importInstance");
    const requestId = crypto.randomUUID();
    const res = await post(
      dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), charset: "\\ISO 2022 IR 87", patientIdBytes: Buffer.from([0x41, 0x1b, 0x24, 0x42, 0x34, 0x35]) }),
      requestId,
    );
    expect(res.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "unsupported_charset" });
  });

  it("同じ要求の ID を二度送っても、Orthanc を呼び直さない", async () => {
    await removeStudy(STUDY);
    const requestId = crypto.randomUUID();
    const file = dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT });
    expect((await post(file, requestId)).status).toBe(200);
    const call = vi.spyOn(await backend(), "importInstance");
    const second = await post(file, requestId);
    expect(call).not.toHaveBeenCalled();
    expect(await second.json()).toMatchObject({ requestId, outcome: "stored", repeated: true });
    expect((await rowsOf(requestId)).filter((r) => detailOf(r).phase === "request")).toHaveLength(1);
  });

  it("同じ要求の ID で同じ検査の別の画像を送ると、前の結果を返さずに 409（画像を抜かさない）", async () => {
    await removeStudy(STUDY);
    const requestId = crypto.randomUUID();
    expect((await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), requestId)).status).toBe(200);
    const call = vi.spyOn(await backend(), "importInstance");
    const other = await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), requestId);
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
    ["StudyInstanceUID が二度ある", dicomFile({ studyInstanceUid: STUDY, append: [{ tag: 0x0020000d, vr: "UI", value: "1.2.826.0.1.3680043.8.498.66" }] }), "malformed"],
    ["File Meta Information Group Length の範囲の外に group 0002 の要素がある", dicomFile({ studyInstanceUid: STUDY, outsideMeta: [{ tag: 0x00020016, vr: "AE", value: "OTHER" }] }), "malformed"],
  ])("%s は Orthanc へ渡す前に 400 で断り、断ったことを記録する", async (_, body, reason) => {
    const call = vi.spyOn(await backend(), "importInstance");
    const requestId = crypto.randomUUID();
    const res = await post(body, requestId);
    expect(res.status).toBe(400);
    expect(call).not.toHaveBeenCalled();
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

  it("答えが分からなければ結果不明で、その間は同じ検査の取り込みを断り、状態の確認で SOP Instance UID を引き当てて照らす", async () => {
    await removeStudy(STUDY_BLOCKED);
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: STUDY_BLOCKED, sopInstanceUid: nextSop(), patientId: PATIENT }), requestId);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ requestId, outcome: "unknown" });
    simulateMockImport({});
    // 結果の分からないうちは、同じ検査の新しい取り込みを断る（検査が Orthanc に無いと読めても）
    await removeStudy(STUDY_BLOCKED);
    const blockedId = crypto.randomUUID();
    const blocked = await post(dicomFile({ studyInstanceUid: STUDY_BLOCKED, sopInstanceUid: nextSop(), patientId: PATIENT }), blockedId);
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ pending: [requestId] });
    expect(detailOf((await rowsOf(blockedId))[0])).toMatchObject({ reason: "unresolved", pending: [requestId] });
  });

  it("結果不明は、状態の確認で SOP Instance UID を引き当て、Orthanc が保存した値と照らして成功を足し、印を付ける", async () => {
    await removeStudy(STUDY);
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    await post(dicomFile({ studyInstanceUid: STUDY, sopInstanceUid: nextSop(), patientId: PATIENT }), requestId);
    simulateMockImport({});
    const checked = await status(requestId);
    expect(await checked.json()).toMatchObject({ requestId, outcome: "stored", reconciled: true, labeled: true });
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "unknown"],
      ["reconcile", "success"],
    ]);
    expect(await listed(STUDY)).toMatchObject({ imported: true });
  });

  it("結果不明を照らして、Orthanc の値がファイルの値と違っても、見つけた画像は消さずに結果不明のまま残す", async () => {
    // 見つけた画像がこの要求の入れたものとは言えない（ほかの道で同じ UID の画像が届いたのかもしれない）。要求は解けないまま残る
    await removeStudy(STUDY_GET_MISMATCH);
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    const sopUid = nextSop();
    await post(dicomFile({ studyInstanceUid: STUDY_GET_MISMATCH, sopInstanceUid: sopUid, patientId: "JP-TEST-0001" }), requestId);
    simulateMockImport({});
    const b = await backend();
    const real = b.studyInfo.bind(b);
    vi.spyOn(b, "studyInfo").mockImplementation(async (id) => {
      const info = await real(id);
      return info && { ...info, patientId: "JP-TEST-0099" };
    });
    const remove = vi.spyOn(b, "deleteImportedInstance");
    const label = vi.spyOn(b, "labelImported");
    const checked = await status(requestId);
    expect(checked.status).toBe(202);
    expect(await checked.json()).toMatchObject({ outcome: "unknown", mismatched: ["patientId"] });
    expect(remove).not.toHaveBeenCalled();
    expect(label).not.toHaveBeenCalled();
    expect((await rowsOf(requestId)).map((r) => [detailOf(r).phase, r.outcome])).toEqual([
      ["request", "success"],
      ["result", "unknown"],
    ]);
    expect(await b.findInstanceStudy(sopUid)).not.toBeNull();
  });

  it("入ったと読めない結果不明は、照らしても結果不明のまま（失敗と確定しない）", async () => {
    await removeStudy(STUDY_LEFT_UNKNOWN);
    const { simulateMockImport } = await import("@/lib/backend/mock");
    simulateMockImport({ unknown: true });
    const requestId = crypto.randomUUID();
    await post(dicomFile({ studyInstanceUid: STUDY_LEFT_UNKNOWN, sopInstanceUid: nextSop(), patientId: "JP-TEST-0001" }), requestId);
    const { restoreMockStudies } = await import("@/lib/backend/mock");
    restoreMockStudies();
    const checked = await status(requestId);
    expect(checked.status).toBe(202);
    expect(await checked.json()).toMatchObject({ outcome: "unknown" });
  });

  it.each([
    [
      "結果不明の削除",
      STUDY_DELETE,
      "delete" as const,
      [{ outcome: "success" as const, detail: { requestId: "6f1c1b7e-9a43-4a7e-8f55-3b1d2c4e5f60", phase: "request" } }],
      "6f1c1b7e-9a43-4a7e-8f55-3b1d2c4e5f60",
    ],
    [
      "結果の無い中身の訂正",
      STUDY_MODIFY,
      "modify" as const,
      [{ outcome: "success" as const, detail: { requestId: "7a2d2c8f-0b54-4b8f-9066-4c2e3d5f6a71", phase: "request", kind: "content" } }],
      "7a2d2c8f-0b54-4b8f-9066-4c2e3d5f6a71",
    ],
    [
      "結果不明の HL7 の更新（書き換え）",
      STUDY_HL7,
      "hl7" as const,
      [
        { outcome: "success" as const, detail: { event: "request", writeId: "w-import-test", StudyInstanceUID: STUDY_HL7 } },
        { outcome: "unknown" as const, detail: { event: "result", writeId: "w-import-test" } },
      ],
      "w-import-test",
    ],
  ])("同じ検査に%sがあれば、取り込みを断る", async (_, uid, action, rows, pendingId) => {
    for (const row of rows) await record(action, uid, row.outcome, row.detail);
    await removeStudy(uid);
    const call = vi.spyOn(await backend(), "importInstance");
    const requestId = crypto.randomUUID();
    const res = await post(dicomFile({ studyInstanceUid: uid, sopInstanceUid: nextSop() }), requestId);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ pending: [pendingId] });
    expect(call).not.toHaveBeenCalled();
    expect((await rowsOf(requestId)).map((r) => r.outcome)).toEqual(["denied"]);
  });

  it("HL7 の更新が手で解かれていれば、取り込みは止めない", async () => {
    // 結果不明の書き換えを、管理者が手で解いた形（manual の照らし合わせ）にする
    await record("hl7", STUDY_HL7_MANUAL, "success", { event: "request", writeId: "w-import-manual", StudyInstanceUID: STUDY_HL7_MANUAL });
    await record("hl7", STUDY_HL7_MANUAL, "unknown", { event: "result", writeId: "w-import-manual" });
    await record("hl7", STUDY_HL7_MANUAL, "success", { event: "reconcile", writeId: "w-import-manual", manual: true });
    await removeStudy(STUDY_HL7_MANUAL);
    const res = await post(dicomFile({ studyInstanceUid: STUDY_HL7_MANUAL, sopInstanceUid: nextSop(), patientId: "JP-TEST-0003" }));
    expect(res.status).toBe(200);
  });
});
