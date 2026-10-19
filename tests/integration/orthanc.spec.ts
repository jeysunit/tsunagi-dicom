import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { startStorescp, stopStorescp, storescpReceived, storescuToOrthanc } from "./support/docker";
import { syntheticStudy, writeDumps, type SyntheticStudy } from "./support/dicom";
import { adminUser, bffUrl, ITEST, orthancUser } from "./support/env";
import { startGate, type Gate } from "./support/gate";
import { observe, writeObservations } from "./support/observations";
import { listJobs, lookupStudy, orthanc, orthancJson, waitFor, type OrthancJob } from "./support/orthanc";
import { isDicomFile, readZip } from "./support/zip";

// 結合の試験（docs/integration-test.md）：本物の Orthanc（DICOMweb のプラグイン・Basic 認証）と DCMTK を相手に、
// BFF（BACKEND_MOCK=false・AUTH_MODE=local）を通して、受け取る → 見る → 送る → 書き出す → 消すを一巡りする。
// docs/round-trip-test.md の手順を、検査装置の試験用のソフトの代わりに DCMTK（storescu・storescp）で流すもの。
// 画面の細かい振る舞いはモックの試験（tests/e2e）で見る。ここでは BFF と Orthanc のつなぎを見る。
// 前の試験の結果に依るので、順に流す。

test.describe.configure({ mode: "serial" });

/** 送る・書き出す */
const A = syntheticStudy("study-a", 1, 3);
/** 消す */
const B = syntheticStudy("study-b", 2, 2);
/** 答えが失われたとき（入口の 504） */
const C = syntheticStudy("study-c", 3, 2);
/** 変更の記録（/changes）が 1 回に返す数の上限を測る（画像の数を多くして、変更の記録を 100 件より多くする） */
const BULK = syntheticStudy("bulk", 4, 120);
const ALL = [A, B, C, BULK];

let gate: Gate;
let admin: { context: BrowserContext; page: Page };
let auditBefore = 0;
const orthancIds = new Map<SyntheticStudy, string>();

async function newContext(browser: Browser) {
  const context = await browser.newContext({ baseURL: bffUrl, locale: "ja-JP" });
  return { context, page: await context.newPage() };
}

async function submitLogin(page: Page, username: string, password: string) {
  await page.goto("/login");
  const form = page.getByRole("form", { name: "ログイン" });
  await form.getByLabel("利用者名").fill(username);
  await form.getByLabel("パスワード").fill(password);
  await form.getByRole("button", { name: "ログイン" }).click();
}

/** 検査の一覧で検査を選び、詳細のパネルを開く */
async function openStudy(page: Page, study: SyntheticStudy) {
  await page.goto("/");
  const row = page.locator(`tr[data-study-uid="${study.studyInstanceUid}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", study.studyInstanceUid);
}

/** 詳細のパネルの「送る」から、試験の送り先（storescp）へ送る */
async function sendToScp(page: Page, study: SyntheticStudy) {
  await openStudy(page, study);
  await page.getByTestId("send-open").click();
  const panel = page.getByTestId("send-panel");
  await panel.getByTestId("send-modality").selectOption(ITEST.scp.id);
  await expect(panel.getByTestId("send-confirm")).toContainText(study.patientId);
  await expect(panel.getByTestId("send-confirm")).toContainText(`${ITEST.scp.id}（${ITEST.scp.aet}）`);
  await panel.getByTestId("send-submit").click();
  return panel;
}

const receivedOf = async (study: SyntheticStudy) =>
  (await storescpReceived()).filter((f) => f.studyInstanceUid === study.studyInstanceUid).map((f) => f.sopInstanceUid);

const storeJobs = async () => (await listJobs()).filter((j) => j.Type === "DicomModalityStore");

/** 仕事の JSON のうち、記録してよい値（名前・状態・誤り。中身の Content は名前だけ） */
const jobShape = (j: OrthancJob) => ({
  keys: Object.keys(j).sort(),
  contentKeys: Object.keys(j.Content ?? {}).sort(),
  State: j.State,
  ErrorCode: j.ErrorCode,
  ErrorDescription: j.ErrorDescription,
  ErrorDetails: typeof j.ErrorDetails === "string" ? j.ErrorDetails.slice(0, 200) : j.ErrorDetails,
});

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  gate = await startGate();
  const system = await orthancJson<{ Version: string; ApiVersion: number }>("system");
  observe("orthanc.version", { Version: system.Version, ApiVersion: system.ApiVersion });

  // 架空の患者の検査を、DCMTK の storescu から Orthanc へ送る（受け取る側の記録に送り元の AE タイトルが残る）
  for (const study of ALL) {
    writeDumps(study);
    await storescuToOrthanc(study.batch);
  }
  for (const study of ALL) {
    const [id] = await waitFor(`Orthanc に ${study.batch} が入る`, () => lookupStudy(study.studyInstanceUid), (ids) => ids.length === 1);
    orthancIds.set(study, id!);
    const instances = await orthancJson<unknown[]>(`studies/${id}/instances`);
    expect(instances).toHaveLength(study.sopInstanceUids.length);
  }
  // 落ち着く（StableStudy）まで待つ。受け取りの記録の並びは、検査ごとのいちばん新しい出来事の順なので
  for (const study of ALL) {
    await waitFor(`${study.batch} が落ち着く`, () => orthancJson<{ IsStable: boolean }>(`studies/${orthancIds.get(study)}`), (s) => s.IsStable);
  }

  // 最初の管理者：決められたパスワードでログインし、自分のパスワードに変える（MFA_REQUIRED=false なので TOTP は登録しない）
  const user = adminUser();
  admin = await newContext(browser);
  const { page } = admin;
  await submitLogin(page, user.username, user.initial);
  await expect(page).toHaveURL(/\/login\/password$/);
  const form = page.getByRole("form", { name: "パスワードの変更" });
  await form.locator('input[name="newPassword"]').fill(user.changed);
  await form.locator('input[name="confirm"]').fill(user.changed);
  await form.getByRole("button", { name: "パスワードを変える" }).click();
  await expect(page).toHaveURL(`${bffUrl}/`);
  const verify = await (await page.request.get("/api/audit/verify")).json();
  expect(verify.ok).toBe(true);
  auditBefore = verify.checked;
});

test.afterAll(async () => {
  writeObservations();
  gate?.setMode("pass");
  await admin?.context.close();
  await gate?.close();
});

test("1 受信一覧：storescu から Orthanc へ送った検査が、時刻・送り元の AE タイトル・画像の数とともに新しい順に出る", async () => {
  const { page } = admin;
  const res = await page.request.get("/api/receive-log");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    complete: boolean;
    items: { receivedAt: string; remoteAet: string | null; origin: string | null; receivedInstances: number; study: { studyInstanceUid: string; patientId: string } }[];
  };
  expect(body.complete).toBe(true);
  const order = body.items.map((i) => i.study.studyInstanceUid).filter((uid) => ALL.some((s) => s.studyInstanceUid === uid));
  // 送った順の逆（新しい順）
  expect(order).toEqual([...ALL].reverse().map((s) => s.studyInstanceUid));
  for (const study of ALL) {
    const item = body.items.find((i) => i.study.studyInstanceUid === study.studyInstanceUid)!;
    expect(item).toMatchObject({ remoteAet: ITEST.scuAet, origin: "DicomProtocol", receivedInstances: study.sopInstanceUids.length });
    expect(item.study.patientId).toBe(study.patientId);
  }

  // 時刻：Orthanc の時刻（時間帯なし）が、いまの時刻からどれだけずれて見えるか（時間帯の違いの分を測る）
  const receivedAt = body.items.find((i) => i.study.studyInstanceUid === A.studyInstanceUid)!.receivedAt;
  expect(receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  const offsetMinutes = (Date.parse(`${receivedAt}Z`) - Date.now()) / 60_000;
  const hours = Math.round(offsetMinutes / 60);
  observe("receiveLog.receivedAtOffsetFromUtcHours", hours);
  expect(Math.abs(offsetMinutes - hours * 60)).toBeLessThan(10);
  expect(Math.abs(hours)).toBeLessThanOrEqual(14);

  // 画面：受け取りの頁に、送り元の AE タイトルと患者 ID が出る
  await page.goto("/received");
  const row = page.getByTestId("received-row").filter({ hasText: A.patientId });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(ITEST.scuAet);

  // 実測：画像のメタデータの名前（値は送り元・受け元の AE タイトルと Origin だけを残す。住所は残さない）
  const [first] = await orthancJson<{ ID: string }[]>(`studies/${orthancIds.get(A)}/instances`);
  const metadata = await orthancJson<Record<string, string>>(`instances/${first!.ID}/metadata?expand`);
  observe("instanceMetadata.keys", Object.keys(metadata).sort());
  observe("instanceMetadata.values", {
    Origin: metadata.Origin,
    RemoteAET: metadata.RemoteAET,
    CalledAET: metadata.CalledAET,
    ReceptionDateForm: metadata.ReceptionDate?.replace(/\d/g, "9"),
  });
  expect(metadata).toMatchObject({ Origin: "DicomProtocol", RemoteAET: ITEST.scuAet, CalledAET: ITEST.orthancAet });

  // 実測：/changes?last と、1 回に返す数の上限
  const last = await orthancJson<{ Changes: unknown[]; Done: boolean; Last: number }>("changes?last");
  observe("changes.last", { keys: Object.keys(last).sort(), changes: last.Changes.length, Done: last.Done, Last: last.Last });
  const big = await orthancJson<{ Changes: unknown[]; Done: boolean; Last: number }>("changes?since=0&limit=1000");
  observe("changes.since0limit1000", { returned: big.Changes.length, Done: big.Done, Last: big.Last, total: last.Last });
  expect(last.Last).toBeGreaterThan(100);

  // BFF の読み方の前提：/studies/{id}/series がシリーズの中身（Instances）を返す
  const series = await orthancJson<{ Instances?: unknown[] }[]>(`studies/${orthancIds.get(A)}/series`);
  observe("studySeries.instancesPresent", series.map((s) => Array.isArray(s.Instances)));
  expect(series).toHaveLength(1);
  expect(series[0]!.Instances).toHaveLength(A.sopInstanceUids.length);
});

test("2 接続先の一覧と接続確認：Orthanc の設定のファイルで登録した storescp が出て、C-ECHO が通る", async () => {
  const { page } = admin;
  const res = await page.request.get("/api/modalities");
  expect(res.status()).toBe(200);
  const { modalities } = (await res.json()) as { modalities: Record<string, unknown>[] };
  expect(modalities.find((m) => m.id === ITEST.scp.id)).toMatchObject({
    id: ITEST.scp.id,
    aet: ITEST.scp.aet,
    host: ITEST.scp.host,
    port: ITEST.scp.port,
  });

  await page.goto("/modalities");
  const row = page.locator(`[data-modality="${ITEST.scp.id}"]`);
  await row.getByTestId("echo").click();
  await expect(row.getByTestId("echo-result")).toHaveText("つながった");
});

test("3 検査の一覧・詳細：本物のデータ（DICOMweb の QIDO-RS と REST）で開き、中継は WADO-RS の読み取りだけを通す", async () => {
  const { page } = admin;
  const list = await page.request.get("/api/studies");
  expect(list.status()).toBe(200);
  const { studies } = (await list.json()) as { studies: Record<string, unknown>[] };
  const a = studies.find((s) => s.studyInstanceUid === A.studyInstanceUid);
  expect(a).toMatchObject({ patientId: A.patientId, accessionNumber: A.accessionNumber, studyDescription: A.studyDescription });
  // 氏名（ISO_IR 192 の UTF-8）が Orthanc を通っても崩れない
  expect(String(a!.patientName)).toContain("試験");
  expect(String(a!.patientKana)).toContain("しけん");
  expect(String(a!.patientNameAlphabetic)).toContain("ITEST");
  expect(a!.modalities).toEqual(["CT"]);

  const detail = await page.request.get(`/api/studies/${A.studyInstanceUid}`);
  expect(detail.status()).toBe(200);

  await openStudy(page, A);
  await expect(page.getByTestId("series-item")).toHaveCount(1);

  // 中継：WADO-RS の metadata は通り、画像の数だけ返る。検索（QIDO-RS）は通さない
  const metadata = await page.request.get(`/api/dicom-web/studies/${A.studyInstanceUid}/metadata`);
  expect(metadata.status()).toBe(200);
  expect(await metadata.json()).toHaveLength(A.sopInstanceUids.length);
  expect((await page.request.get("/api/dicom-web/studies")).status()).toBe(404);

  // 画像サーバーのパスワードは、頁にも API の答えにも出ない
  const { password } = orthancUser();
  expect(await page.content()).not.toContain(password);
  expect(await list.text()).not.toContain(password);
  expect(await detail.text()).not.toContain(password);
});

test("4 送信：tsunagi-dicom から storescp へ送り、storescp に同じ UID の画像が同じ数だけ届く", async () => {
  test.setTimeout(180_000);
  const { page } = admin;
  const panel = await sendToScp(page, A);
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Success", { timeout: 90_000 });
  await expect(panel.getByTestId("send-status")).toHaveText("送った");

  const received = await waitFor("storescp に A が届く", () => receivedOf(A), (uids) => uids.length >= A.sopInstanceUids.length);
  expect([...received].sort()).toEqual([...A.sopInstanceUids].sort());

  const job = (await storeJobs()).find((j) => j.State === "Success");
  expect(job).toBeDefined();
  observe("job.success", jobShape(job!));

  // 実測：仕事の状態の移り方（Orthanc へ直に、画像の多い検査を非同期で送り、状態を細かく読む）
  const created = await orthancJson<{ ID: string }>(`modalities/${ITEST.scp.id}/store`, {
    method: "POST",
    body: JSON.stringify({ Resources: [orthancIds.get(BULK)], Synchronous: false }),
    contentType: "application/json",
  });
  const states: string[] = [];
  const until = Date.now() + 120_000;
  for (;;) {
    const j = await orthancJson<OrthancJob>(`jobs/${created.ID}`);
    if (states.at(-1) !== j.State) states.push(j.State);
    if (j.State === "Success" || j.State === "Failure" || Date.now() > until) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  observe("job.stateSequence", states);
  expect(states.at(-1)).toBe("Success");
  const bulk = await waitFor("storescp に BULK が届く", () => receivedOf(BULK), (uids) => uids.length >= BULK.sopInstanceUids.length);
  expect(new Set(bulk)).toEqual(new Set(BULK.sopInstanceUids));
});

test("5 送り先を止めると：接続確認は「つながらない」、送ると「送れなかった」と Orthanc の誤りの文言が出る", async () => {
  test.setTimeout(240_000);
  const { page } = admin;
  const before = new Set((await storeJobs()).map((j) => j.ID));
  await stopStorescp();
  try {
    await page.goto("/modalities");
    const row = page.locator(`[data-modality="${ITEST.scp.id}"]`);
    await row.getByTestId("echo").click();
    await expect(row.getByTestId("echo-result")).toHaveText("つながらない", { timeout: 60_000 });

    const panel = await sendToScp(page, A);
    await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Failure", { timeout: 120_000 });
    await expect(panel.getByTestId("send-status")).toContainText("送れなかった");

    const failed = (await storeJobs()).find((j) => !before.has(j.ID) && j.State === "Failure");
    expect(failed).toBeDefined();
    observe("job.failureScpStopped", jobShape(failed!));
    // 画面は Orthanc の誤りの文言（ErrorDescription）を添える
    if (failed!.ErrorDescription) await expect(panel.getByTestId("send-status")).toContainText(failed!.ErrorDescription);
    expect(failed!.ErrorCode).not.toBe(0);
  } finally {
    await startStorescp();
  }
  await waitFor(
    "storescp が戻る",
    async () => (await orthanc(`modalities/${ITEST.scp.id}/echo`, { method: "POST", body: "{}", contentType: "application/json" })).status,
    (status) => status === 200,
    90_000,
  );
});

test("6 エクスポート：ZIP が開け、中の DICOM のファイルの数が検査の画像の数と合う", async () => {
  const { page } = admin;
  const res = await page.request.get(`/api/studies/${A.studyInstanceUid}/export`);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/zip");
  expect(res.headers()["content-disposition"] ?? "").toMatch(/study-[0-9a-f]{8}\.zip/);
  const entries = readZip(await res.body());
  observe("export.entries", { count: entries.length, maxDepth: Math.max(...entries.map((e) => e.name.split("/").length)) });
  expect(entries.filter((e) => isDicomFile(e.data))).toHaveLength(A.sopInstanceUids.length);
  expect(entries).toHaveLength(A.sopInstanceUids.length);
});

test("7 削除：管理者が理由と再認証（パスワード）を通して消すと、Orthanc から消える", async ({ browser }) => {
  test.setTimeout(120_000);
  // 新しくログインしたセッション（まだ再認証していない）で流し、消す前に必ず再認証を求められることを見る
  const fresh = await newContext(browser);
  try {
    const { page } = fresh;
    const user = adminUser();
    await submitLogin(page, user.username, user.changed);
    await expect(page).toHaveURL(`${bffUrl}/`);
    await openStudy(page, B);
    await page.getByTestId("delete-open").click();
    const panel = page.getByTestId("delete-panel");
    await expect(panel.getByTestId("delete-confirm")).toContainText(B.patientId);
    await panel.getByTestId("delete-reason").fill("結合の試験で作った検査を消す");
    await panel.getByTestId("delete-submit").click();
    const reauth = panel.getByTestId("delete-reauth");
    await expect(reauth).toBeVisible();
    // 再認証の前は消えていない
    expect(await lookupStudy(B.studyInstanceUid)).toHaveLength(1);
    await reauth.getByLabel("パスワード").fill(user.changed);
    await reauth.getByRole("button", { name: "確かめて消す" }).click();
    await expect(page.locator(`tr[data-study-uid="${B.studyInstanceUid}"]`)).toHaveCount(0, { timeout: 30_000 });

    expect(await lookupStudy(B.studyInstanceUid)).toEqual([]);
    expect((await orthanc(`studies/${orthancIds.get(B)}`)).status).toBe(404);
  } finally {
    await fresh.context.close();
  }
});

test("8（round-trip-test の 7）答えが失われたとき：Orthanc は送るが画面は「結果が分からない」、同じ送り先へは重ねて送れず、管理者が照らす", async () => {
  test.setTimeout(240_000);
  const { page } = admin;
  const before = new Set((await storeJobs()).map((j) => j.ID));
  gate.setMode("drop-store-response");
  let requestId = "";
  try {
    const panel = await sendToScp(page, C);
    const status = panel.getByTestId("send-status");
    await expect(status).toHaveAttribute("data-state", "Unknown", { timeout: 60_000 });
    await expect(status).toContainText("結果が分からない");
    requestId = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.exec(await status.innerText())?.[0] ?? "";
    expect(requestId).not.toBe("");
    expect(gate.dropped).toHaveLength(1);
    expect(gate.dropped[0]!.status).toBe(200);
    observe("gate.droppedStoreResponse", { status: gate.dropped[0]!.status, keys: Object.keys(JSON.parse(gate.dropped[0]!.body)).sort() });
  } finally {
    gate.setMode("pass");
  }

  // Orthanc は仕事を作り、storescp に届いている
  const job = await waitFor(
    "C の送る仕事が終わる",
    async () => (await storeJobs()).find((j) => !before.has(j.ID)),
    (j) => j?.State === "Success",
    90_000,
  );
  expect(job).toBeDefined();
  const received = await waitFor("storescp に C が届く", () => receivedOf(C), (uids) => uids.length >= C.sopInstanceUids.length);
  expect(new Set(received)).toEqual(new Set(C.sopInstanceUids));

  // 新しく送ろうとしても、同じ検査・同じ送り先は断られ、先の要求の ID を確かめるように出る
  const again = await sendToScp(page, C);
  await expect(again.getByTestId("send-status")).toHaveAttribute("data-state", "Unknown", { timeout: 30_000 });
  await expect(again.getByTestId("send-status")).toContainText(requestId);
  expect((await storeJobs()).filter((j) => !before.has(j.ID))).toHaveLength(1);

  // 管理者が送り先で確かめた内容を書き、「届いていた」を記録する
  await again.getByTestId("send-resolve-note").fill("storescp の受け取りの記録で、同じ UID の 2 件を確かめた（結合の試験）");
  await again.getByTestId("send-resolve").getByRole("button", { name: "届いていた" }).click();
  await expect(again.getByTestId("send-status")).toHaveAttribute("data-state", "Settled");
  await expect(again.getByTestId("send-status")).toContainText("届いていたと記録した");

  // 照らした後は、また送れる
  await again.getByTestId("send-submit").click();
  await expect(again.getByTestId("send-status")).toHaveAttribute("data-state", "Success", { timeout: 90_000 });
});

test("9 監査のつなぎ：/api/audit/verify が ok で、試験の操作の分だけ行が増えている", async () => {
  const { page } = admin;
  const res = await page.request.get("/api/audit/verify");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  // 受け取り・機器・一覧・詳細・送る（3 回分の求めた・結果）・書き出し・削除・照らし合わせ。少なめに数える
  expect(body.checked).toBeGreaterThanOrEqual(auditBefore + 15);
  observe("audit.rowsAdded", body.checked - auditBefore);
});
