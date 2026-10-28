import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "@/lib/config";
import { testDatabases } from "./helpers/test-db";

// 段 6 の患者・検査の値の修正（docs/spec.md の 3.5。openspec/changes/add-study-value-correction）を、検証モード
// （AUTH_MODE=dev。モックの Orthanc）のセッションから通して確かめる。属性の訂正（患者情報修正）は UID を保ち、
// 中身の訂正（検査情報修正）は新しい UID の検査を作る。混ぜた要求・値の形・役割・理由・確かめの token・監査の記録・
// 結果不明と部分反映・HL7 の書き換えとの組み合わせを見る。再認証（AUTH_MODE=local）は tests/e2e で見る。

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
    headers: async () => new Headers({ "x-forwarded-for": "192.0.2.10" }),
  };
});

vi.mock("@/lib/config", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/config")>();
  return { ...real, getConfig: () => state.config! };
});

// JP-TEST-0001（検査が2件）の1件目と2件目、JP-TEST-0002 の1件
const STUDY = "1.2.826.0.1.3680043.8.498.12580196157444326238324642149044327503";
const SIBLING = "1.2.826.0.1.3680043.8.498.45255015335478509141706689498950755880";
const OTHER = "1.2.826.0.1.3680043.8.498.92586672124270452901721343807821604204";
const ORIGIN = "http://127.0.0.1:3000";
const dbs = testDatabases("tsunagi-study-correction-");

beforeAll(async () => {
  dbs.setup();
  const { loadConfig } = await import("@/lib/config");
  state.config = loadConfig({
    BACKEND_MOCK: "true",
    AUTH_MODE: "dev",
    DEV_ALLOW_WRITE: "true",
    SESSION_SECRET: "m".repeat(48),
    DATABASE_URL: dbs.freshUrl(),
  });
}, 60_000);
afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  await (await getDb()).$disconnect();
  dbs.teardown();
});
beforeEach(() => {
  state.role = "general";
  state.config!.auth.devAllowWrite = true;
  vi.restoreAllMocks();
});
afterEach(async () => {
  // 試験が残した結果不明・部分反映の書き換えと、結果不明の中身の訂正を、管理者が手で解いて片付ける
  vi.restoreAllMocks();
  state.role = "admin";
  // 動いたままのモックの仕事を終わらせる（動いている仕事の書き換えは、管理者も解けないため）
  const { hl7Jobs } = await import("@/lib/backend/mock");
  for (const job of hl7Jobs.values()) job.state = "Success";
  const { history, unresolved } = await import("@/lib/keep-uid-write");
  for (const d of unresolved(await history())) await resolveWrite({ writeId: d.writeId, note: "試験の片付け" });
  const { pendingAttribute, pendingContent } = await import("@/app/api/studies/[uid]/modify/shared");
  for (const uid of [STUDY, SIBLING, OTHER]) {
    for (const requestId of await pendingContent(await db(), uid)) await resolveContent({ requestId, note: "試験の片付け" }, uid);
    // 書き換えを解いた後の、要求全体の結果の無い属性の訂正は、照会で決める
    for (const requestId of await pendingAttribute(await db(), uid)) await status(requestId, uid);
  }
  const { restoreMockStudies, simulateMockHl7 } = await import("@/lib/backend/mock");
  simulateMockHl7({});
  restoreMockStudies();
});

const uidParams = (uid: string) => ({ params: Promise.resolve({ uid }) });
const post = (path: string, body: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin, host: new URL(ORIGIN).host },
    body: JSON.stringify(body),
  });
async function db() {
  const { getDb } = await import("@/lib/db");
  return getDb();
}
async function backend() {
  const { getBackend } = await import("@/lib/backend");
  return getBackend();
}
const detailOf = (row: { detail: string | null } | null | undefined) => JSON.parse(row?.detail ?? "{}") as Record<string, unknown>;
async function rowsOf(requestId: string) {
  return (await db()).auditLog.findMany({ where: { action: "modify", detail: { contains: requestId } }, orderBy: { seq: "asc" } });
}
const phaseRow = async (requestId: string, phase: string) => (await rowsOf(requestId)).find((r) => detailOf(r).phase === phase);

type Values = Record<string, string>;
async function preview(kind: string, values: Values, uid = STUDY, extra: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/studies/[uid]/modify/preview/route");
  return POST(post(`/api/studies/${uid}/modify/preview`, { kind, values, ...extra }), uidParams(uid));
}
async function tokenOf(kind: string, values: Values, uid = STUDY, extra: Record<string, unknown> = {}) {
  const res = await preview(kind, values, uid, extra);
  return res.ok ? ((await res.json()).confirmToken as string) : "m1.none.none.none";
}
/** 値の修正を求める。本文に confirmToken が無ければ、いま確かめの画面を開いて token を添える */
async function modify(body: Record<string, unknown>, uid = STUDY, origin = ORIGIN) {
  const { POST } = await import("@/app/api/studies/[uid]/modify/route");
  const full: Record<string, unknown> = {
    requestId: crypto.randomUUID(),
    reason: "取り違えの修正（試験）",
    ...body,
  };
  const withToken = "confirmToken" in full
    ? full
    : { ...full, confirmToken: await tokenOf(String(full.kind), full.values as Values, uid, full.orthancId ? { orthancId: full.orthancId } : {}) };
  return POST(post(`/api/studies/${uid}/modify`, withToken, origin), uidParams(uid));
}
async function status(requestId: string, uid = STUDY) {
  const { GET } = await import("@/app/api/studies/[uid]/modify/route");
  return GET(new Request(`${ORIGIN}/api/studies/${uid}/modify?requestId=${requestId}`), uidParams(uid));
}
async function resolveWrite(body: unknown) {
  const { POST } = await import("@/app/api/hl7/resolve/route");
  return POST(post("/api/hl7/resolve", body));
}
async function resolveContent(body: unknown, uid = STUDY) {
  const { POST } = await import("@/app/api/studies/[uid]/modify/resolve/route");
  return POST(post(`/api/studies/${uid}/modify/resolve`, body), uidParams(uid));
}
/** UID の検査の全部の画像（同じ UID の検査が複数あれば全部） */
async function instancesOf(uid: string) {
  const b = await backend();
  return (await Promise.all((await b.lookupStudyIds(uid)).map((id) => b.studyInstanceTags(id)))).flat();
}
const triples = (list: { StudyInstanceUID: string; SeriesInstanceUID: string; SOPInstanceUID: string }[]) =>
  list.map((i) => `${i.StudyInstanceUID}|${i.SeriesInstanceUID}|${i.SOPInstanceUID}`).sort();

describe("値の修正の分け方と値の形", () => {
  it("2種類を混ぜた要求は 400 で断り、Orthanc を呼ばずに、断ったことを記録する", async () => {
    const b = await backend();
    const spy = vi.spyOn(b, "modifyStudyKeepingUids");
    const copy = vi.spyOn(b, "modifyStudyNewUid");
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientName: "Yamada^Jiro", StudyDate: "20260101" }, confirmToken: "m1.x.x.x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("別々に修正");
    const rows = await rowsOf(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied", studyInstanceUid: STUDY });
    expect(detailOf(rows[0])).toMatchObject({ reason: "invalid" });
    expect(spy).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it("種類と項目が合わない要求（属性の訂正で検査名）は 400", async () => {
    const res = await modify({ kind: "attribute", values: { StudyDescription: "頭部CT" }, confirmToken: "m1.x.x.x" });
    expect(res.status).toBe(400);
    const res2 = await modify({ kind: "content", values: { PatientName: "Yamada^Jiro" }, confirmToken: "m1.x.x.x" });
    expect(res2.status).toBe(400);
  });

  it("患者ID を空にする・形の違う値・範囲の違う属性を混ぜた要求は 400", async () => {
    for (const values of [
      { PatientID: "" },
      { PatientBirthDate: "2026-01-01" },
      { PatientBirthDate: "20260230" },
      { PatientSex: "X" },
      { AccessionNumber: "x".repeat(17) },
      { PatientName: "a=b=c=d" },
      { PatientName: "Yamada\u0007" },
      { PatientName: "Yamada‮" },
      { PatientID: "JP*" },
      { AccessionNumber: "A1", PatientName: "Yamada^Jiro" },
    ]) {
      expect((await modify({ kind: "attribute", values, confirmToken: "m1.x.x.x" })).status, JSON.stringify(values)).toBe(400);
    }
    expect((await modify({ kind: "content", values: { StudyDescription: "x".repeat(65) }, confirmToken: "m1.x.x.x" })).status).toBe(400);
  });

  it("理由が無い・空白だけ・長すぎる要求は 400 で断り、断ったことを記録する", async () => {
    for (const reason of [undefined, "", "   ", "x".repeat(501)]) {
      const requestId = crypto.randomUUID();
      const res = await modify({ requestId, kind: "attribute", values: { PatientSex: "F" }, reason });
      expect(res.status).toBe(400);
      expect((await rowsOf(requestId))[0]).toMatchObject({ outcome: "denied" });
    }
  });

  it("元の検査を消す指定は、どの役割でも断る（消すのは削除の操作）", async () => {
    for (const role of ["general", "admin"]) {
      state.role = role;
      const requestId = crypto.randomUUID();
      const res = await modify({ requestId, kind: "content", values: { StudyDate: "20260101" }, deleteSource: true });
      expect(res.status).toBe(400);
      expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "delete_source" });
    }
    expect(await (await backend()).lookupStudyIds(STUDY)).toHaveLength(1);
  });

  it("別の画面からの要求・検証モードの書き込みの止めは断る", async () => {
    expect((await modify({ kind: "attribute", values: { PatientSex: "F" }, confirmToken: "m1.x.x.x" }, STUDY, "https://evil.example.org")).status).toBe(403);
    state.config!.auth.devAllowWrite = false;
    const requestId = crypto.randomUUID();
    expect((await modify({ requestId, kind: "attribute", values: { PatientSex: "F" }, confirmToken: "m1.x.x.x" })).status).toBe(403);
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "dev_write_blocked" });
  });
});

describe("属性の訂正（患者情報修正）", () => {
  it("氏名の訂正は、同じ患者ID の全部の検査の全部の画像に当たり、UID は変わらず、前と後の値を記録する", async () => {
    const before = [...await instancesOf(STUDY), ...await instancesOf(SIBLING)];
    const other = await instancesOf(OTHER);
    const p = await preview("attribute", { PatientName: "Yamada^Jiro=山田^次郎=やまだ^じろう" });
    expect(p.status).toBe(200);
    const shown = await p.json();
    expect(shown).toMatchObject({ kind: "attribute", scope: "patient" });
    expect(shown.studies).toHaveLength(2);
    expect(shown.fields.PatientName).toEqual({ before: "Yamada^Taro=山田^太郎=やまだ^たろう", after: "Yamada^Jiro=山田^次郎=やまだ^じろう" });
    // 当てる検査ごとの修正前の値（検査どうしで値が違っても、確かめの画面で分かる）
    for (const st of shown.studies) expect(st.before).toEqual({ PatientName: "Yamada^Taro=山田^太郎=やまだ^たろう" });
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientName: "Yamada^Jiro=山田^次郎=やまだ^じろう" }, confirmToken: shown.confirmToken });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "modified", count: 2, total: 2 });
    const after = [...await instancesOf(STUDY), ...await instancesOf(SIBLING)];
    expect(triples(after)).toEqual(triples(before));
    expect(after.every((i) => i.PatientName === "Yamada^Jiro=山田^次郎=やまだ^じろう" && i.PatientID === "JP-TEST-0001")).toBe(true);
    expect(await (await backend()).lookupStudyIds(STUDY)).toHaveLength(1);
    // ほかの患者は変わらない
    expect(await instancesOf(OTHER)).toEqual(other);
    const request = await phaseRow(requestId, "request");
    expect(request).toMatchObject({ outcome: "success", actorRole: "general", patientId: "JP-TEST-0001", studyInstanceUid: STUDY });
    expect(detailOf(request)).toMatchObject({
      kind: "attribute",
      scope: "patient",
      reason: "取り違えの修正（試験）",
      fields: { PatientName: { before: "Yamada^Taro=山田^太郎=やまだ^たろう", after: "Yamada^Jiro=山田^次郎=やまだ^じろう" } },
      StudyInstanceUID: STUDY,
    });
    expect((detailOf(request).studies as unknown[]).length).toBe(2);
    const result = await phaseRow(requestId, "result");
    expect(result).toMatchObject({ outcome: "success" });
    expect(detailOf(result)).toMatchObject({ count: 2, total: 2, newStudyInstanceUid: STUDY });
    // 書き換えごとの経過は、HL7 と同じ部品の行（request・dispatch・result）として残る
    const events = (await rowsOf(requestId)).map((r) => detailOf(r).event).filter(Boolean);
    // 2 件の検査をまとめた組（group）を先に残し、全部を書き換え終えたら閉じる
    expect(events[0]).toBe("group");
    expect(events.filter((e) => e === "request")).toHaveLength(2);
    expect(events.filter((e) => e === "result")).toHaveLength(3);
    expect(detailOf((await rowsOf(requestId)).filter((r) => detailOf(r).event === "result").at(-1))).toMatchObject({ partial: false, count: 2, total: 2 });
    // 同じ要求の ID は二度流さない
    const again = await modify({ requestId, kind: "attribute", values: { PatientName: "Yamada^Jiro=山田^次郎=やまだ^じろう" }, confirmToken: shown.confirmToken });
    expect(await again.json()).toMatchObject({ outcome: "modified", repeated: true });
  });

  it("空だった値を入れた後に、空の文字列で値を空に戻せる（タグは残る）", async () => {
    expect((await modify({ kind: "attribute", values: { PatientBirthDate: "19800101" } })).status).toBe(200);
    expect((await instancesOf(STUDY)).every((i) => i.PatientBirthDate === "19800101")).toBe(true);
    expect((await modify({ kind: "attribute", values: { PatientBirthDate: "" } })).status).toBe(200);
    const after = await instancesOf(STUDY);
    expect(after.every((i) => i.PatientBirthDate === "")).toBe(true);
  });

  it("受付番号の訂正は選んだ1検査だけに当たる", async () => {
    const sibling = await instancesOf(SIBLING);
    const p = await (await preview("attribute", { AccessionNumber: "ACC-NEW-1" })).json();
    expect(p).toMatchObject({ scope: "accession" });
    expect(p.studies).toHaveLength(1);
    expect((await modify({ kind: "attribute", values: { AccessionNumber: "ACC-NEW-1" }, confirmToken: p.confirmToken })).status).toBe(200);
    expect((await instancesOf(STUDY)).every((i) => i.AccessionNumber === "ACC-NEW-1")).toBe(true);
    expect(await instancesOf(SIBLING)).toEqual(sibling);
  });

  it("患者ID の付け替え：選んだ検査だけが新しい患者ID へ移り、UID は変わらず、元の患者のほかの検査は残り、見回りの覚えを残す", async () => {
    state.role = "admin";
    const before = await instancesOf(STUDY);
    const sibling = await instancesOf(SIBLING);
    const p = await (await preview("attribute", { PatientID: "JP-TEST-0099" })).json();
    expect(p).toMatchObject({ scope: "reassign", target: { exists: false } });
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientID: "JP-TEST-0099" }, confirmToken: p.confirmToken });
    expect(res.status).toBe(200);
    const after = await instancesOf(STUDY);
    expect(triples(after)).toEqual(triples(before));
    expect(after.every((i) => i.PatientID === "JP-TEST-0099" && i.PatientName === before[0]!.PatientName)).toBe(true);
    expect(await (await backend()).lookupStudyIds(STUDY)).toHaveLength(1);
    expect(await instancesOf(SIBLING)).toEqual(sibling);
    expect(await (await backend()).findStudiesByPatientId("JP-TEST-0001")).toHaveLength(1);
    // 付け替えの印を付けてから書き換え、外した
    expect(detailOf((await rowsOf(requestId)).find((r) => detailOf(r).event === "lock"))).toMatchObject({ event: "lock" });
    const result = await phaseRow(requestId, "result");
    expect(detailOf(result).remember).toMatchObject({ kind: "alias", origin: "screen", from: "JP-TEST-0001", to: "JP-TEST-0099", studies: [STUDY] });
    const { memory } = await import("@/lib/hl7/sweep");
    const { history } = await import("@/lib/keep-uid-write");
    expect(memory(await history()).aliases.at(-1)).toMatchObject({ from: "JP-TEST-0001", to: "JP-TEST-0099", origin: "screen" });
  });

  it("替え先の患者がいれば、その値にそろえる。入力した値が違えば書き換えずに断る", async () => {
    // JP-TEST-0002 の氏名は Shiken^Hanako=試験^花子=しけん^はなこ
    const mismatch = await preview("attribute", { PatientID: "JP-TEST-0002", PatientName: "Yamada^Taro" });
    expect(mismatch.status).toBe(409);
    // 期待の変更：前は断る応答に付け替え先の患者の値（target）を返していた。患者の値は記録を残す確かめの成功の応答だけで見せるので、
    // 断る応答には「違う」ことだけを返し、付け替え先の氏名・生年月日・性別を含めない
    const mismatchBody = await mismatch.json();
    expect(mismatchBody).toEqual({ error: "付け替え先の患者の登録と、入力した氏名・生年月日・性別が違います" });
    expect(JSON.stringify(mismatchBody)).not.toMatch(/Shiken|試験|しけん|1995/);
    const spy = vi.spyOn(await backend(), "modifyStudyKeepingUids");
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientID: "JP-TEST-0002", PatientName: "Yamada^Taro" }, confirmToken: "m1.x.x.x" });
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(/Shiken|試験|しけん|1995/);
    expect(spy).not.toHaveBeenCalled();
    const p = await (await preview("attribute", { PatientID: "JP-TEST-0002" })).json();
    expect(p.target).toMatchObject({ exists: true, PatientName: "Shiken^Hanako=試験^花子=しけん^はなこ" });
    expect((await modify({ kind: "attribute", values: { PatientID: "JP-TEST-0002" }, confirmToken: p.confirmToken })).status).toBe(200);
    expect((await instancesOf(STUDY)).every((i) => i.PatientID === "JP-TEST-0002" && i.PatientName === "Shiken^Hanako=試験^花子=しけん^はなこ")).toBe(true);
  });

  it("実行の道でも、確かめた値と違う氏名を添えた付け替えは、書き換えずに 409 で断る。応答と監査の行に付け替え先の値を入れない", async () => {
    // 正しい確かめの token を取ってから、氏名を替えて実行する（confirm_invalid で先に断られず、target_mismatch の道に届く）
    const token = await tokenOf("attribute", { PatientID: "JP-TEST-0002" });
    expect(token).not.toBe("m1.none.none.none");
    const before = await instancesOf(STUDY);
    const spy = vi.spyOn(await backend(), "modifyStudyKeepingUids");
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientID: "JP-TEST-0002", PatientName: "Yamada^Taro" }, confirmToken: token });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "付け替え先の患者の登録と、入力した氏名・生年月日・性別が違います" });
    expect(spy).not.toHaveBeenCalled();
    expect(await instancesOf(STUDY)).toEqual(before);
    const rows = await rowsOf(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "denied", studyInstanceUid: STUDY });
    expect(detailOf(rows[0])).toMatchObject({ reason: "target_mismatch" });
    expect(rows[0]!.detail).not.toMatch(/Shiken|試験|しけん|1995/);
  });

  it("確かめの画面を開いた後に検査が変わったら（HL7 の更新など）、書き換えずに 409", async () => {
    const p = await (await preview("attribute", { PatientSex: "F" })).json();
    // 確かめの後に、HL7 の A08 と同じ書き換えで氏名が変わった形
    const b = await backend();
    const [id] = await b.lookupStudyIds(STUDY);
    await b.modifyStudyKeepingUids(id!, { PatientName: "Changed^ByRis" });
    const spy = vi.spyOn(b, "modifyStudyKeepingUids");
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientSex: "F" }, confirmToken: p.confirmToken });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("確認の後に検査が更新されました");
    expect(spy).not.toHaveBeenCalled();
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "changed" });
  });

  it("確かめの画面を開いた後に、HL7 の A40 がその検査を別の患者へ移したら、書き換えずに 409。A40 の後のまま変わらない", async () => {
    const p = await (await preview("attribute", { PatientName: "Yamada^Jiro" })).json();
    const b = await backend();
    const [id] = await b.lookupStudyIds(STUDY);
    // A40 と同じ書き換え（患者 ID を替える。モックは検査を新しい ID へ移す）
    await b.modifyStudyKeepingUids(id!, { PatientID: "JP-TEST-0077" });
    const moved = await instancesOf(STUDY);
    const res = await modify({ kind: "attribute", values: { PatientName: "Yamada^Jiro" }, confirmToken: p.confirmToken });
    expect(res.status).toBe(409);
    expect(await instancesOf(STUDY)).toEqual(moved);
    expect(moved.every((i) => i.PatientID === "JP-TEST-0077" && i.PatientName !== "Yamada^Jiro")).toBe(true);
  });

  it("確かめの token は、別の利用者・別の種類・別の検査・期限切れでは使えない", async () => {
    const token = await tokenOf("attribute", { PatientSex: "F" });
    // 別の利用者（検証モードの利用者は1人なので、token の中の利用者を替えた形）
    const { signModifyConfirm, openModifyConfirm } = await import("@/lib/pacs-ops");
    const opened = openModifyConfirm(token, state.config!.sessionSecret)!;
    const foreign = signModifyConfirm({ ...opened, actorId: "someone-else" }, state.config!.sessionSecret);
    expect((await modify({ kind: "attribute", values: { PatientSex: "F" }, confirmToken: foreign })).status).toBe(409);
    expect((await modify({ kind: "attribute", values: { PatientSex: "F" }, confirmToken: token }, SIBLING)).status).toBe(409);
    expect((await modify({ kind: "attribute", values: { PatientName: "X" }, confirmToken: token })).status).toBe(409);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
    expect((await modify({ kind: "attribute", values: { PatientSex: "F" }, confirmToken: token })).status).toBe(409);
  });

  it("書き換えの後の確かめが合わなければ部分反映。照らし合わせが済むまで値の修正と HL7 の書き換えを断り、管理者が解くと戻る", async () => {
    const { simulateMockHl7 } = await import("@/lib/backend/mock");
    // 部分反映の前に開いた、別の患者の検査の確かめの画面
    const otherToken = await tokenOf("attribute", { PatientSex: "M" }, OTHER);
    const otherContent = await tokenOf("content", { StudyDate: "20260101" }, OTHER);
    simulateMockHl7({ changedInstances: 1 });
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { AccessionNumber: "ACC-PART" } });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ outcome: "partial" });
    simulateMockHl7({});
    // 確かめの画面も、実行も断る（別の患者の検査でも。HL7 と同じく、全部の書き換えを止める）
    const pv = await preview("attribute", { PatientSex: "M" }, OTHER);
    expect(pv.status).toBe(409);
    expect((await pv.json()).error).toContain("管理者が確認するまで、修正はできません");
    const blocked = await modify({ kind: "attribute", values: { PatientSex: "M" }, confirmToken: otherToken }, OTHER);
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toContain("管理者が確認するまで、修正はできません");
    // 中身の訂正は、部分反映の残る検査だけを止める（別の検査の写しは作れる）
    expect((await modify({ kind: "content", values: { StudyDate: "20260101" }, confirmToken: "m1.x.x.x" })).status).toBe(409);
    expect((await modify({ kind: "content", values: { StudyDate: "20260101" }, confirmToken: otherContent }, OTHER)).status).toBe(200);
    // HL7 の書き換えも止まる
    const { processMessage } = await import("@/lib/hl7/apply");
    const { readFileSync } = await import("node:fs");
    const message = readFileSync("tests/fixtures/hl7/a08.hl7", "utf8");
    expect(await processMessage(Buffer.from(message), "192.0.2.1", await backend(), undefined, { issuer: "RIS_EMU", allowWrite: true })).toContain("MSA|AE|");
    // 状態の照会は、解いていない書き換えの ID を返す
    const s = await (await status(requestId)).json();
    expect(s.outcome).toBe("unknown");
    expect(s.unresolvedWriteIds).toHaveLength(1);
    // 一般は解けない。管理者が解くと、照らし合わせの行は modify の行として残り、次の修正が通る
    expect((await resolveWrite({ writeId: s.unresolvedWriteIds[0], note: "試験" })).status).toBe(403);
    state.role = "admin";
    expect((await resolveWrite({ writeId: s.unresolvedWriteIds[0], note: "Orthanc の画像を全部確かめた（試験）" })).status).toBe(200);
    const reconciled = (await (await db()).auditLog.findMany({ where: { action: "modify" }, orderBy: { seq: "desc" }, take: 1 }))[0];
    expect(detailOf(reconciled)).toMatchObject({ event: "reconcile", manual: true, writeId: s.unresolvedWriteIds[0] });
    // 値の揃っていない検査は、確かめの画面に揃っていない項目を出し、もう一度の訂正で揃え直せる
    const again = await (await preview("attribute", { AccessionNumber: "ACC-PART" })).json();
    expect(again.studies[0].mixed).toEqual(["AccessionNumber"]);
    expect((await modify({ kind: "attribute", values: { AccessionNumber: "ACC-PART" }, confirmToken: again.confirmToken })).status).toBe(200);
    expect((await instancesOf(STUDY)).every((i) => i.AccessionNumber === "ACC-PART")).toBe(true);
    expect((await modify({ kind: "attribute", values: { PatientSex: "F" } })).status).toBe(200);
  });

  it("画像どうしで氏名が揃っていない検査で受付番号だけを直しても、氏名は書き換えない", async () => {
    const { simulateMockHl7 } = await import("@/lib/backend/mock");
    simulateMockHl7({ changedInstances: 1 });
    expect((await modify({ kind: "attribute", values: { PatientName: "Mixed^One" } })).status).toBe(502);
    simulateMockHl7({});
    state.role = "admin";
    const { history, unresolved } = await import("@/lib/keep-uid-write");
    for (const d of unresolved(await history())) expect((await resolveWrite({ writeId: d.writeId, note: "試験" })).status).toBe(200);
    // 部分反映で、画像どうしの氏名が揃わなくなった検査（患者の 2 件の検査のうち、先に書き換えた方）
    let mixed = "";
    for (const uid of [STUDY, SIBLING]) if (new Set((await instancesOf(uid)).map((i) => i.PatientName)).size === 2) mixed = uid;
    expect(mixed).not.toBe("");
    const names = (await instancesOf(mixed)).map((i) => i.PatientName);
    const spy = vi.spyOn(await backend(), "modifyStudyKeepingUids");
    expect((await modify({ kind: "attribute", values: { AccessionNumber: "ACC-ONLY" } }, mixed)).status).toBe(200);
    expect(spy.mock.calls.at(-1)![1]).toEqual({ AccessionNumber: "ACC-ONLY" });
    expect((await instancesOf(mixed)).map((i) => i.PatientName)).toEqual(names);
  });

  it("同じ患者の検査を書き換える途中で止まったら、部分反映として残し、管理者が解くまで値の修正と HL7 の書き換えを止める", async () => {
    const b = await backend();
    const real = b.modifyStudyKeepingUids.bind(b);
    let calls = 0;
    // 2 件目の検査の書き換えを、Orthanc が断った形（その検査は何も変わらない）
    vi.spyOn(b, "modifyStudyKeepingUids").mockImplementation(async (id, replace) => {
      calls++;
      if (calls === 2) throw new (await import("@/lib/backend/types")).BackendError("画像サーバーが書き換えを断りました（500）");
      return real(id, replace);
    });
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientSex: "O" } });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ outcome: "partial", count: 1, total: 2 });
    vi.restoreAllMocks();
    const { history, unresolved } = await import("@/lib/keep-uid-write");
    const pending = unresolved(await history());
    // 止まった組（同じ患者の 2 件の検査の書き換え）が残る
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ messageId: requestId, group: expect.arrayContaining([STUDY, SIBLING]) });
    expect((await modify({ kind: "attribute", values: { PatientSex: "F" } }, OTHER)).status).toBe(409);
    const { processMessage } = await import("@/lib/hl7/apply");
    const { readFileSync } = await import("node:fs");
    const message = readFileSync("tests/fixtures/hl7/a08.hl7", "utf8").replace("20261024201531A08A", "ACROSS-STUDIES");
    expect(await processMessage(Buffer.from(message), "192.0.2.1", b, undefined, { issuer: "RIS_EMU", allowWrite: true })).toContain("MSA|AE|");
    state.role = "admin";
    expect((await resolveWrite({ writeId: pending[0]!.writeId, note: "2 件目の検査を確かめた（試験）" })).status).toBe(200);
    state.role = "general";
    // もう一度同じ修正を求めると、直った検査は飛ばし、残りの検査だけを書き換える
    const again = await modify({ kind: "attribute", values: { PatientSex: "O" } });
    expect(await again.json()).toMatchObject({ outcome: "modified", count: 1, total: 2 });
  });

  it("途中の検査の結果が分からず、後で照らし合わせがその書き換えを解いても、組が残り、管理者が解くまで止める", async () => {
    const b = await backend();
    const { BackendUnknownError } = await import("@/lib/backend/types");
    const real = b.jobStatus.bind(b);
    let polls = 0;
    // 2 件目の検査の仕事の状態を読めない（結果不明）。仕事そのものは Orthanc で成功している
    vi.spyOn(b, "jobStatus").mockImplementation(async (id) => {
      polls++;
      if (polls === 2) throw new BackendUnknownError();
      return real(id);
    });
    const res = await modify({ kind: "attribute", values: { PatientSex: "O" } });
    expect(res.status).toBe(202);
    vi.restoreAllMocks();
    const { history, reconcile, unresolved, writeAudit } = await import("@/lib/keep-uid-write");
    expect(unresolved(await history())).toHaveLength(2);
    // 照らし合わせ（HL7 の受信・見回り・値の修正の前に流れる）が、2 件目の書き換えを成功と解く。組は残る
    expect(await reconcile(b, [...await history()], writeAudit)).toBe(false);
    const blocked = await modify({ kind: "attribute", values: { PatientSex: "M" } }, OTHER);
    expect(blocked.status).toBe(409);
    const left = unresolved(await history());
    expect(left).toHaveLength(1);
    expect(left[0]!.group).toBeDefined();
  });

  it("最初の検査の仕事の状態を読めずに止まっても（Orthanc が 503）、組は閉じず、照らし合わせの後も管理者が解くまで止める。照会は組の ID を返す", async () => {
    const b = await backend();
    const { BackendError } = await import("@/lib/backend/types");
    const real = b.jobStatus.bind(b);
    let polls = 0;
    vi.spyOn(b, "jobStatus").mockImplementation(async (id) => {
      polls++;
      if (polls === 1) throw new BackendError("画像サーバーがエラーを返しました（503）");
      return real(id);
    });
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { PatientSex: "O" } });
    // 書き換えの部品は結果不明と記録したので、結果不明として返す
    expect(res.status).toBe(202);
    vi.restoreAllMocks();
    const { history, reconcile, unresolved, writeAudit } = await import("@/lib/keep-uid-write");
    expect(await reconcile(b, [...await history()], writeAudit)).toBe(false);
    const left = unresolved(await history());
    expect(left).toHaveLength(1);
    expect(left[0]!.group).toEqual(expect.arrayContaining([STUDY, SIBLING]));
    const s = await (await status(requestId)).json();
    expect(s).toMatchObject({ outcome: "unknown", unresolvedWriteIds: [left[0]!.writeId] });
    // 修正の窓を開き直したとき（同じ患者のほかの検査からでも）、待っている修正と書き換えの ID を返す
    const { GET } = await import("@/app/api/studies/[uid]/modify/route");
    for (const uid of [STUDY, SIBLING]) {
      const listed = await (await GET(new Request(`${ORIGIN}/api/studies/${uid}/modify`), uidParams(uid))).json();
      expect(listed.pending).toEqual([{ requestId, kind: "attribute", writeIds: [left[0]!.writeId] }]);
    }
    // 組は仕事の ID を持たないので、Orthanc に終わっていない書き換えの仕事があれば、管理者も解けない
    state.role = "admin";
    const { hl7Jobs } = await import("@/lib/backend/mock");
    hl7Jobs.set("running-job", { state: "Running" });
    expect((await resolveWrite({ writeId: left[0]!.writeId, note: "試験" })).status).toBe(409);
    hl7Jobs.delete("running-job");
  });

  it("患者情報修正のジョブがまだ動いていれば、管理者も解けず、後の修正も止まったまま", async () => {
    const b = await backend();
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(b, "jobStatus").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    expect((await modify({ requestId, kind: "attribute", values: { AccessionNumber: "ACC-RUN" } })).status).toBe(202);
    vi.restoreAllMocks();
    const { history, unresolved } = await import("@/lib/keep-uid-write");
    const [write] = unresolved(await history());
    state.role = "admin";
    const running = vi.spyOn(b, "jobStatus").mockResolvedValue({
      id: "x", state: "Running", progress: 50, errorCode: 0, errorDescription: "", creationTime: "", completionTime: null,
    });
    const r = await resolveWrite({ writeId: write!.writeId, note: "試験" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("まだ動いています");
    expect(unresolved(await history())).toHaveLength(1);
    running.mockRestore();
    expect((await resolveWrite({ writeId: write!.writeId, note: "ジョブの終わりを確かめた（試験）" })).status).toBe(200);
  });

  it("同じ患者のほかの検査に結果不明の検査情報修正が残っていれば、患者情報修正を断る", async () => {
    const b = await backend();
    vi.spyOn(b, "modifyStudyNewUid").mockRejectedValueOnce(new (await import("@/lib/backend/types")).BackendUnknownError());
    expect((await modify({ kind: "content", values: { StudyDate: "20260101" } }, SIBLING)).status).toBe(202);
    const token = await tokenOf("attribute", { PatientSex: "O" });
    expect(token).toBe("m1.none.none.none");
    // 確かめの画面を通らずに求めても、列の中で断る
    vi.restoreAllMocks();
    const res = await modify({ kind: "attribute", values: { PatientSex: "O" }, confirmToken: "m1.x.x.x" });
    expect(res.status).toBe(409);
  });

  it("HL7 の書き換えが結果不明のままなら、画面の値の修正も断る", async () => {
    const token = await tokenOf("attribute", { PatientSex: "M" }, OTHER);
    // HL7 の受け口が書き換えを求めた後、答えの来ないまま止まった形（仕事の ID の無い request の行）
    const { appendAudit } = await import("@/lib/audit");
    const b = await backend();
    const id = (await b.lookupStudyIds(STUDY))[0]!;
    const tags = await b.studyInstanceTags(id);
    await appendAudit(await db(), {
      actorId: "hl7-receiver",
      actorRole: "system",
      authMode: "hl7",
      action: "hl7",
      outcome: "success",
      studyInstanceUid: STUDY,
      detail: { event: "request", writeId: crypto.randomUUID(), messageId: crypto.randomUUID(), oldOrthancId: id, StudyInstanceUID: STUDY, before: tags, after: tags },
    });
    const res = await modify({ kind: "attribute", values: { PatientSex: "M" }, confirmToken: token }, OTHER);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("管理者が確認するまで、修正はできません");
  });

  it("答えが分からなければ結果不明（202）として記録し、照会では解いていない書き換えを返す", async () => {
    const { simulateMockHl7 } = await import("@/lib/backend/mock");
    simulateMockHl7({ state: "Running" });
    const requestId = crypto.randomUUID();
    const { POST } = await import("@/app/api/studies/[uid]/modify/route");
    const token = await tokenOf("attribute", { PatientSex: "F" });
    // 仕事の終わりを待つ時間を縮める代わりに、仕事の状態を読む答えを結果不明にする
    vi.spyOn(await backend(), "jobStatus").mockRejectedValueOnce(new (await import("@/lib/backend/types")).BackendUnknownError());
    const res = await POST(post(`/api/studies/${STUDY}/modify`, { requestId, kind: "attribute", values: { PatientSex: "F" }, reason: "試験", confirmToken: token }), uidParams(STUDY));
    expect(res.status).toBe(202);
    expect(await phaseRow(requestId, "result")).toMatchObject({ outcome: "unknown" });
    // 結果不明の書き換えと、閉じていない組（同じ患者の 2 件の検査）の2つ
    expect((await (await status(requestId)).json()).unresolvedWriteIds).toHaveLength(2);
  });

  it("Orthanc に OverwriteInstances が無ければ、患者情報修正を始める前に断る", async () => {
    const { simulateMockHl7 } = await import("@/lib/backend/mock");
    simulateMockHl7({ noOverwriteInstances: true });
    const p = await preview("attribute", { PatientSex: "F" });
    expect(p.status).toBe(409);
    expect((await p.json()).error).toContain("OverwriteInstances");
    simulateMockHl7({});
    const token = await tokenOf("attribute", { PatientSex: "F" });
    simulateMockHl7({ noOverwriteInstances: true });
    const requestId = crypto.randomUUID();
    expect((await modify({ requestId, kind: "attribute", values: { PatientSex: "F" }, confirmToken: token })).status).toBe(409);
    expect(detailOf((await rowsOf(requestId))[0])).toMatchObject({ reason: "orthanc_config" });
    // 中身の訂正は、この設定に依らない
    expect((await modify({ kind: "content", values: { StudyDescription: "頭部CT（試験）" } })).status).toBe(200);
  });

  it("書き換えた後に要求全体の結果を記録できなくても、窓を開き直して要求を見つけ、照会で書き換えごとの記録から結果を決める", async () => {
    const session = await import("@/lib/auth/session");
    const real = session.audit;
    // 要求全体の結果の行（phase result）だけを、記録の失敗にする
    vi.spyOn(session, "audit").mockImplementation(async (s, fields, source) => {
      if ((fields.detail as { phase?: unknown } | undefined)?.phase === "result") throw new Error("記録の失敗");
      return real(s, fields, source);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "attribute", values: { AccessionNumber: "ACC-LOST" } });
    expect(res.status).toBe(202);
    vi.restoreAllMocks();
    expect((await instancesOf(STUDY)).every((i) => i.AccessionNumber === "ACC-LOST")).toBe(true);
    const { GET } = await import("@/app/api/studies/[uid]/modify/route");
    const listed = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/modify`), uidParams(STUDY))).json();
    expect(listed.pending).toEqual([{ requestId, kind: "attribute", writeIds: [] }]);
    expect(await (await status(requestId)).json()).toMatchObject({ outcome: "modified", reconciled: true });
    expect(await phaseRow(requestId, "reconcile")).toMatchObject({ outcome: "success" });
    const again = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/modify`), uidParams(STUDY))).json();
    expect(again.pending).toEqual([]);
  });

  it("患者ID の付け替えの要求全体の結果を記録できなくても、照会で決めた結果の行に見回りの覚えを残す（期限は求めた時刻から）", async () => {
    state.role = "admin";
    const session = await import("@/lib/auth/session");
    const real = session.audit;
    vi.spyOn(session, "audit").mockImplementation(async (s, fields, source) => {
      if ((fields.detail as { phase?: unknown } | undefined)?.phase === "result") throw new Error("記録の失敗");
      return real(s, fields, source);
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const requestId = crypto.randomUUID();
    expect((await modify({ requestId, kind: "attribute", values: { PatientID: "JP-TEST-0088" } })).status).toBe(202);
    vi.restoreAllMocks();
    const requested = await phaseRow(requestId, "request");
    expect(await (await status(requestId)).json()).toMatchObject({ outcome: "modified", reconciled: true });
    const reconciled = await phaseRow(requestId, "reconcile");
    expect(detailOf(reconciled).remember).toMatchObject({ kind: "alias", origin: "screen", from: "JP-TEST-0001", to: "JP-TEST-0088", at: requested!.occurredAt.toISOString() });
    const { memory } = await import("@/lib/hl7/sweep");
    const { history } = await import("@/lib/keep-uid-write");
    expect(memory(await history()).aliases.at(-1)).toMatchObject({ from: "JP-TEST-0001", to: "JP-TEST-0088" });
  });

  it("記録できなければ Orthanc を呼ばない", async () => {
    const session = await import("@/lib/auth/session");
    const spy = vi.spyOn(await backend(), "modifyStudyKeepingUids");
    const token = await tokenOf("attribute", { PatientSex: "F" });
    vi.spyOn(session, "auditIf").mockRejectedValueOnce(new Error("記録の失敗"));
    const res = await modify({ kind: "attribute", values: { PatientSex: "F" }, confirmToken: token });
    expect(res.status).toBe(500);
    expect(spy).not.toHaveBeenCalled();
  });

  it("同じ UID の検査が複数あれば、選ぶための一覧を返し、選んだ検査だけを付け替える", async () => {
    const { duplicateMockStudy } = await import("@/lib/backend/mock");
    duplicateMockStudy(STUDY);
    const b = await backend();
    const [real] = (await b.lookupStudyIds(STUDY)).filter((id) => !id.startsWith("00000000"));
    // モックの重なりの検査は要点を持たないので、一覧には読める検査だけが出る
    const ambiguous = await preview("attribute", { PatientID: "JP-TEST-0098" });
    expect(ambiguous.status).toBe(409);
    expect((await ambiguous.json()).candidates.map((c: { orthancId: string }) => c.orthancId)).toEqual([real]);
    const p = await preview("attribute", { PatientID: "JP-TEST-0098" }, STUDY, { orthancId: real });
    expect(p.status).toBe(200);
    expect((await p.json()).orthancId).toBe(real);
  });
});

describe("修正の窓に最初に入れる、いまの値（GET …/modify/preview）", () => {
  it("study.modify の無い役割には 403 を返し、いまの値を返さず、断ったことを記録する", async () => {
    const { ROLE_PERMISSIONS } = await import("@/lib/auth/roles");
    const { GET } = await import("@/app/api/studies/[uid]/modify/preview/route");
    const original = ROLE_PERMISSIONS.general;
    ROLE_PERMISSIONS.general = original.filter((p) => p !== "study.modify");
    try {
      state.role = "general";
      const res = await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/modify/preview`), uidParams(STUDY));
      expect(res.status).toBe(403);
      expect(JSON.stringify(await res.json())).not.toMatch(/JP-TEST-0001|Yamada/);
      const row = await (await db()).auditLog.findFirst({ where: { action: "modify", outcome: "denied" }, orderBy: { seq: "desc" } });
      expect(row).toMatchObject({ studyInstanceUid: STUDY });
      expect(detailOf(row)).toMatchObject({ via: "current", reason: "forbidden", permission: "study.modify" });
    } finally {
      ROLE_PERMISSIONS.general = original;
    }
  });

  it("Orthanc から読んだいまの値を返し、患者の値を見せたことを記録する。形の違う検査の ID は 400 で断る", async () => {
    const { GET } = await import("@/app/api/studies/[uid]/modify/preview/route");
    const res = await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/modify/preview`), uidParams(STUDY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.values).toEqual({
      PatientID: "JP-TEST-0001",
      PatientName: "Yamada^Taro=山田^太郎=やまだ^たろう",
      PatientBirthDate: expect.any(String),
      PatientSex: expect.any(String),
      AccessionNumber: "ACC-0001-1",
      StudyDate: "20260410",
      StudyDescription: "胸部CT 単純（試験）",
    });
    expect(body.mixed).toEqual([]);
    const viewed = (await (await db()).auditLog.findMany({ where: { action: "view_study" }, orderBy: { seq: "desc" }, take: 1 }))[0];
    expect(detailOf(viewed)).toMatchObject({ via: "modify_current" });
    expect((await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/modify/preview?orthancId=x`), uidParams(STUDY))).status).toBe(400);
  });
});

describe("中身の訂正（検査情報修正）", () => {
  it("検査日の訂正は、新しい StudyInstanceUID の検査を作り、元の検査を残す", async () => {
    const source = await instancesOf(STUDY);
    const p = await (await preview("content", { StudyDate: "20260101" })).json();
    expect(p).toMatchObject({ scope: "content", fields: { StudyDate: { before: "20260410", after: "20260101" } } });
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "content", values: { StudyDate: "20260101" }, confirmToken: p.confirmToken });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ outcome: "created", studyInstanceUid: STUDY });
    expect(body.newStudyInstanceUid).toMatch(/^2\.25\.\d+$/);
    expect(body.newStudyInstanceUid.length).toBeLessThanOrEqual(64);
    // 元は残る
    expect(await instancesOf(STUDY)).toEqual(source);
    const b = await backend();
    const [id] = await b.lookupStudyIds(body.newStudyInstanceUid);
    expect((await b.studyInfo(id!))?.studyDate).toBe("20260101");
    const created = await instancesOf(body.newStudyInstanceUid);
    expect(created).toHaveLength(source.length);
    // Series・SOP の UID も新しい
    const old = new Set(source.flatMap((i) => [i.SeriesInstanceUID, i.SOPInstanceUID]));
    expect(created.every((i) => !old.has(i.SeriesInstanceUID) && !old.has(i.SOPInstanceUID))).toBe(true);
    const request = await phaseRow(requestId, "request");
    expect(detailOf(request)).toMatchObject({ kind: "content", newStudyInstanceUid: body.newStudyInstanceUid, fields: { StudyDate: { before: "20260410", after: "20260101" } } });
    expect(detailOf(await phaseRow(requestId, "dispatch"))).toMatchObject({ kind: "content" });
    expect(await phaseRow(requestId, "result")).toMatchObject({ outcome: "success" });
    expect(detailOf(await phaseRow(requestId, "result"))).toMatchObject({ newStudyInstanceUid: body.newStudyInstanceUid, sourceKept: true, matches: true });
  });

  it("答えが分からなければ結果不明。照会で、作るはずの UID の検査を見つけて照らす", async () => {
    const b = await backend();
    const { BackendUnknownError } = await import("@/lib/backend/types");
    // 仕事は作られたが、終わりを読めなかった
    vi.spyOn(b, "jobStatus").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    const res = await modify({ requestId, kind: "content", values: { StudyDescription: "胸部CT 造影（試験）" } });
    expect(res.status).toBe(202);
    vi.restoreAllMocks();
    // 仕事がまだ動いていると読めるあいだは、作られた検査があっても確定しない
    const running = vi.spyOn(b, "jobStatus").mockResolvedValueOnce({
      id: "x", state: "Running", progress: 50, errorCode: 0, errorDescription: "", creationTime: "", completionTime: null,
    });
    expect(await (await status(requestId)).json()).toMatchObject({ outcome: "unknown", studyCreated: null });
    running.mockRestore();
    // 結果不明の間は、同じ検査の新しい修正を断り、HL7 の書き換えも止める（Orthanc が元を写している最中かもしれない）
    expect((await modify({ kind: "content", values: { StudyDate: "20260101" } })).status).toBe(409);
    const { processMessage } = await import("@/lib/hl7/apply");
    const { readFileSync } = await import("node:fs");
    const message = readFileSync("tests/fixtures/hl7/a08.hl7", "utf8").replace("20261024201531A08A", "CONTENT-PENDING");
    expect(await processMessage(Buffer.from(message), "192.0.2.1", await backend(), undefined, { issuer: "RIS_EMU", allowWrite: true })).toContain("MSA|AE|");
    const s = await status(requestId);
    expect(s.status).toBe(200);
    expect(await s.json()).toMatchObject({ outcome: "created", reconciled: true });
    expect(await phaseRow(requestId, "reconcile")).toMatchObject({ outcome: "success" });
  });

  it("作られた検査を確かめられなければ部分反映として残し、管理者が解くまで同じ検査の修正を断る", async () => {
    const b = await backend();
    const real = b.lookupStudyIds.bind(b);
    const requestId = crypto.randomUUID();
    const token = await tokenOf("content", { StudyDate: "20260101" });
    // 仕事の後の確かめで、元の検査が見つからない形
    const spyCopy = vi.spyOn(b, "modifyStudyNewUid");
    vi.spyOn(b, "lookupStudyIds").mockImplementation(async (uid) => (uid === STUDY && spyCopy.mock.calls.length > 0 ? [] : real(uid)));
    const res = await modify({ requestId, kind: "content", values: { StudyDate: "20260101" }, confirmToken: token });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ outcome: "partial" });
    vi.restoreAllMocks();
    expect(await phaseRow(requestId, "result")).toMatchObject({ outcome: "failed" });
    expect((await status(requestId)).status).toBe(202);
    expect((await modify({ kind: "content", values: { StudyDescription: "別の修正" } })).status).toBe(409);
    state.role = "admin";
    const r = await resolveContent({ requestId, note: "作られた検査と元の検査を確かめた（試験）" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "created", matches: true, sourceKept: true });
    state.role = "general";
    expect((await modify({ kind: "content", values: { StudyDescription: "別の修正" } })).status).toBe(200);
  });

  it("Orthanc のジョブがまだ動いていれば、管理者も解けない。HL7 の解除の道からも解けない", async () => {
    const b = await backend();
    const { BackendUnknownError } = await import("@/lib/backend/types");
    vi.spyOn(b, "jobStatus").mockRejectedValueOnce(new BackendUnknownError());
    const requestId = crypto.randomUUID();
    expect((await modify({ requestId, kind: "content", values: { StudyDate: "20260101" } })).status).toBe(202);
    vi.restoreAllMocks();
    state.role = "admin";
    const running = vi.spyOn(b, "jobStatus").mockResolvedValue({
      id: "x", state: "Running", progress: 50, errorCode: 0, errorDescription: "", creationTime: "", completionTime: null,
    });
    const r = await resolveContent({ requestId, note: "試験" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("まだ動いています");
    running.mockRestore();
    const { history, unresolved } = await import("@/lib/keep-uid-write");
    const group = unresolved(await history()).find((d) => d.messageId === requestId)!;
    expect(group).toBeDefined();
    expect((await resolveWrite({ writeId: group.writeId, note: "試験" })).status).toBe(409);
    expect((await resolveContent({ requestId, note: "ジョブの終わりを確かめた（試験）" })).status).toBe(200);
    expect(unresolved(await history()).find((d) => d.messageId === requestId)).toBeUndefined();
  });

  it("作られた検査が見つからず、仕事の ID も分からなければ、管理者が手で解く", async () => {
    const b = await backend();
    vi.spyOn(b, "modifyStudyNewUid").mockRejectedValueOnce(new (await import("@/lib/backend/types")).BackendUnknownError());
    const requestId = crypto.randomUUID();
    expect((await modify({ requestId, kind: "content", values: { StudyDate: "20260101" } })).status).toBe(202);
    expect((await status(requestId)).status).toBe(202);
    expect((await resolveContent({ requestId, note: "試験" })).status).toBe(403);
    // 修正の窓を開き直したときに、状態の確認と解除の道へ戻れる（本人と管理者に、この検査の待っている修正を返す）
    const { GET } = await import("@/app/api/studies/[uid]/modify/route");
    const listed = await (await GET(new Request(`${ORIGIN}/api/studies/${STUDY}/modify`), uidParams(STUDY))).json();
    expect(listed.pending).toEqual([{ requestId, kind: "content", writeIds: [] }]);
    state.role = "admin";
    // 仕事の ID が分からないので、Orthanc に終わっていない書き換えの仕事があれば解かない
    const { hl7Jobs } = await import("@/lib/backend/mock");
    hl7Jobs.set("running-job", { state: "Running" });
    const refused = await resolveContent({ requestId, note: "試験" });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("終わっていない書き換えのジョブ");
    hl7Jobs.delete("running-job");
    const r = await resolveContent({ requestId, note: "Orthanc のジョブの一覧に無いことを確かめた（試験）" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ outcome: "failed" });
    expect(detailOf(await phaseRow(requestId, "reconcile"))).toMatchObject({ manual: true });
    expect((await resolveContent({ requestId, note: "再度" })).status).toBe(409);
    state.role = "general";
    expect((await modify({ kind: "content", values: { StudyDate: "20260101" } })).status).toBe(200);
  });
});
