import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { compose, startStorescp, stopStorescp, storescpReceived, storescuToOrthanc } from "./support/docker";
import { newUid, syntheticStudy, writeDumps, type SyntheticStudy } from "./support/dicom";
import { adminUser, bffUrl, ITEST, orthancUser } from "./support/env";
import { latestCsrfToken, readAudit, requestTrails } from "./support/audit-db";
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
  await form.getByLabel("ユーザーID").fill(username);
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

/** Orthanc の時刻（`YYYYMMDDTHHMMSS`。時間帯の印なし）を UTC と読んだとき、いまの時刻から何時間ずれるか。読めなければ null */
function hoursFromUtcNow(value: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!m) return null;
  const at = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  // -0 を 0 にそろえる
  return Math.round((at - Date.now()) / 3_600_000) || 0;
}

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
  await form.getByRole("button", { name: "変更" }).click();
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

  // 時刻：Orthanc の変更の記録の Date（時間帯の印なし）は UTC（docs/spec.md の 3.3）。コンテナの時間帯（TZ=Asia/Tokyo）に依らないことを測る。
  // BFF の receivedAt は UTC の時刻（印なしか Z つき）で、いまの時刻から 10 分の内
  const containerZone = (await compose(["exec", "-T", "orthanc", "date", "+%z"])).trim();
  const lastChange = await orthancJson<{ Changes: { Date: string }[] }>("changes?last");
  const rawOffsetHours = hoursFromUtcNow(lastChange.Changes[0]!.Date);
  observe("changes.dateClock", { containerZone, offsetFromUtcHours: rawOffsetHours });
  expect(rawOffsetHours).toBe(0);
  const receivedAt = body.items.find((i) => i.study.studyInstanceUid === A.studyInstanceUid)!.receivedAt;
  expect(receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?$/);
  const at = Date.parse(receivedAt.endsWith("Z") ? receivedAt : `${receivedAt}Z`);
  expect(Math.abs(at - Date.now())).toBeLessThan(10 * 60_000);

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
  observe("instanceMetadata.receptionDateOffsetFromUtcHours", hoursFromUtcNow(metadata.ReceptionDate ?? ""));
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
  await expect(row.getByTestId("echo-result")).toHaveText(/^成功 \d{2}:\d{2}:\d{2}$/);
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

  // 画像サーバーのパスワードは、頁にも API の答えにも出ない（失敗したときの文言に値を出さないよう、真偽だけを比べる）
  const { password } = orthancUser();
  const leaked = [await page.content(), await list.text(), await detail.text()].some((text) => text.includes(password));
  expect(leaked, "画像サーバーのパスワードが頁か API の答えに出た").toBe(false);
});

test("4 送信：tsunagi-dicom から storescp へ送り、storescp に同じ UID の画像が同じ数だけ届く", async () => {
  test.setTimeout(180_000);
  const { page } = admin;
  const panel = await sendToScp(page, A);
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Success", { timeout: 90_000 });
  // 結果には送信先・画像の数・時刻が出る（docs/spec.md の 3.4）
  await expect(panel.getByTestId("send-status")).toHaveText(
    new RegExp(`^送信完了：${ITEST.scp.id}（${ITEST.scp.aet}） へ ${A.sopInstanceUids.length} 画像（\\d{2}:\\d{2}:\\d{2}）$`),
  );
  // 受け付けた後は、同じ画面から重ねて送らない（実行のボタンは外れ、「閉じる」だけが出る）
  await expect(panel.getByTestId("send-submit")).toHaveCount(0);
  await expect(panel.getByTestId("send-close")).toHaveText("閉じる");

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
    await expect(row.getByTestId("echo-result")).toHaveText(/^失敗 \d{2}:\d{2}:\d{2}（.+）$/, { timeout: 60_000 });
    // 実測：C-ECHO が通らないときの Orthanc の答え（BFF は 500 を「つながらない」と読む）
    const echo = await orthanc(`modalities/${ITEST.scp.id}/echo`, { method: "POST", body: JSON.stringify({ Timeout: 10 }), contentType: "application/json" });
    const echoBody = await echo.text();
    observe("echo.failure", { status: echo.status, bodyKeys: echoBody.startsWith("{") ? Object.keys(JSON.parse(echoBody)).sort() : null });
    expect(echo.status).toBe(500);

    const panel = await sendToScp(page, A);
    await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Failure", { timeout: 120_000 });
    await expect(panel.getByTestId("send-status")).toContainText("送信失敗");

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
    await reauth.getByRole("button", { name: "認証して削除" }).click();
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
  let requestId: string;
  try {
    const panel = await sendToScp(page, C);
    const status = panel.getByTestId("send-status");
    await expect(status).toHaveAttribute("data-state", "Unknown", { timeout: 60_000 });
    await expect(status).toContainText("送信結果を確認できません");
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
  await again.getByTestId("send-resolve").getByRole("button", { name: "送信済みとして記録" }).click();
  await expect(again.getByTestId("send-status")).toHaveAttribute("data-state", "Settled");
  await expect(again.getByTestId("send-status")).toContainText("送信済みとして記録しました");

  // 照らした後は、また送れる（同じ画面からは送り直せない：開き直して新しい送信の確かめの画面にする）
  const third = await sendToScp(page, C);
  await expect(third.getByTestId("send-status")).toHaveAttribute("data-state", "Success", { timeout: 90_000 });
});

test("9 監査のつなぎ：/api/audit/verify が ok で、試験の操作の分だけ行が増えている", async () => {
  const { page } = admin;
  const res = await page.request.get("/api/audit/verify");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.checked).toBeGreaterThan(auditBefore);
  observe("audit.rowsAdded", body.checked - auditBefore);
  // 鍵つきのつなぎ（鍵の無い行は無い）と、起動の時に書き出した先頭の控え（AUDIT_ANCHOR_FILE）との照らし合わせ
  expect(body.legacy).toBe(0);
  expect(body.anchors.status).toBe("checked");
  expect(body.anchors.checked).toBeGreaterThanOrEqual(1);
  const anchorLines = readFileSync(path.join(ITEST.workDir, "audit-anchors.jsonl"), "utf8").trim().split("\n");
  const firstAnchor = JSON.parse(anchorLines[0]!) as { seq: number; hash: string; keyId: string | null };
  expect(firstAnchor.keyId).toMatch(/^[0-9a-f]{16}$/);
  expect(firstAnchor.hash).toMatch(/^[0-9a-f]{64}$/);

  // 操作ごとの行：つなぎが正しいだけでなく、書き込みの操作ごとに「求めた」「結果」「終わり」が要求の ID で結ばれている
  const rows = readAudit();
  const trailsOf = (action: string, study: SyntheticStudy) => [...requestTrails(rows, action, study.studyInstanceUid).values()];
  // 送る A：送れた 1 回と、送り先を止めて送れなかった 1 回
  expect(trailsOf("send", A)).toEqual(
    expect.arrayContaining([
      ["request:success", "result:success", "done:success"],
      ["request:success", "result:success", "done:failed"],
    ]),
  );
  expect(trailsOf("send", A)).toHaveLength(2);
  // 送る C：答えが失われた 1 回（結果不明 → 管理者が届いていたと照らした）と、照らした後の 1 回
  expect(trailsOf("send", C)).toEqual([
    ["request:success", "result:unknown", "reconcile:success"],
    ["request:success", "result:success", "done:success"],
  ]);
  // 結果不明の間に重ねて送ろうとした要求は、Orthanc を呼ばずに断った行だけが残る
  expect(
    rows.filter((r) => r.action === "send" && r.studyInstanceUid === C.studyInstanceUid && r.outcome === "denied" && r.detail.reason === "unresolved"),
  ).toHaveLength(1);
  // 削除 B：求めた → 送る直前（dispatch）→ 結果
  expect(trailsOf("delete", B)).toEqual([["request:success", "dispatch:success", "result:success"]]);
  // 書き出し A：求めた → 流し終えた
  // 書き出しの結果の行は、10 で見る
  // C-ECHO：つながった・つながらないの両方が、送り先の名前つきで残る
  const echoes = rows.filter((r) => r.action === "echo" && r.detail.modality === ITEST.scp.id).map((r) => r.detail.connected);
  expect(echoes).toEqual(expect.arrayContaining([true, false]));
});

// 本物の Orthanc で見つけた食い違い（直すまで、この試験は赤のまま）。最後に置き、ほかの試験を止めない。
// どちらも期待は緩めない（docs/round-trip-test.md の「実測で決めること」）
test("10 書き出しの結果が記録に残り、サムネイルがブラウザの Accept のまま中継から画像で返る", async () => {
  const { page } = admin;
  // 書き出し：流し終えた「結果」の行（求めた行と要求の ID で結ぶ）
  const exportTrail = [...requestTrails(readAudit(), "export", A.studyInstanceUid).values()];
  observe("audit.exportTrail", exportTrail);
  expect.soft(exportTrail, "書き出しの結果の行が記録されていない").toEqual([["request:success", "result:success"]]);

  // サムネイル：一覧と詳細の <img> は、ブラウザの画像の Accept（Chromium の既定）のまま中継を通る。
  // 直すときの手がかりとして、JPEG を名指ししたときの答えも残す
  const thumbnail = `/api/dicom-web/studies/${A.studyInstanceUid}/thumbnail`;
  const asImg = await page.request.get(thumbnail, { headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" } });
  const asJpeg = await page.request.get(thumbnail, { headers: { accept: "image/jpeg" } });
  observe("relay.thumbnail", {
    browserAccept: { status: asImg.status(), contentType: asImg.headers()["content-type"] ?? null },
    jpegAccept: { status: asJpeg.status(), contentType: asJpeg.headers()["content-type"] ?? null },
  });
  expect.soft(asImg.status(), "ブラウザの Accept のままのサムネイルが画像で返らない").toBe(200);
  expect.soft(asImg.headers()["content-type"] ?? "", "サムネイルの答えが画像でない").toMatch(/^image\//);
});

test("11 詳細条件：生年月日・性別・受付番号・検査名が、本物の Orthanc の QIDO-RS で引ける（2026-10-21）", async () => {
  test.setTimeout(180_000);
  const { page } = admin;
  // 詳細条件の値だけを替えた、架空の患者の検査を2つ足す（生年月日は同じ、性別・受付番号・検査名は違う）
  const D = syntheticStudy("adv-d", 21, 1, {
    patientBirthDate: "19750510",
    patientSex: "F",
    accessionNumber: "IT-ADV-0001",
    studyDescription: "Chest CT plain",
  });
  const E = syntheticStudy("adv-e", 22, 1, {
    patientBirthDate: "19750510",
    patientSex: "M",
    accessionNumber: "IT-ADV-0002",
    studyDescription: "HEAD CT",
  });
  for (const study of [D, E]) {
    writeDumps(study);
    await storescuToOrthanc(study.batch);
    await waitFor(`Orthanc に ${study.batch} が入る`, () => lookupStudy(study.studyInstanceUid), (ids) => ids.length === 1);
  }
  /** BFF の画面の API で絞った検査（試験で足した2つのうちのどれか） */
  const found = async (params: Record<string, string>) => {
    const res = await page.request.get(`/api/studies?${new URLSearchParams(params)}`);
    expect(res.status()).toBe(200);
    const { studies } = (await res.json()) as { studies: { studyInstanceUid: string }[] };
    return [D, E].filter((s) => studies.some((r) => r.studyInstanceUid === s.studyInstanceUid)).map((s) => s.batch);
  };
  // Orthanc の QIDO-RS の答え（BFF が後から確かめて捨てる前）。大文字と小文字の扱いを記録する
  const raw = async (query: Record<string, string>) => {
    const rows = await orthancJson<Record<string, { Value?: unknown[] }>[]>(`dicom-web/studies?${new URLSearchParams(query)}`);
    return [D, E].filter((s) => rows.some((r) => r["0020000D"]?.Value?.[0] === s.studyInstanceUid)).map((s) => s.batch);
  };

  expect(await found({ birth: "1975-05-10" })).toEqual(["adv-d", "adv-e"]);
  expect(await found({ birth: "1975-05-10", sex: "F" })).toEqual(["adv-d"]);
  expect(await found({ accession: "ADV-0002" })).toEqual(["adv-e"]);
  expect(await found({ desc: "Chest CT" })).toEqual(["adv-d"]);
  // ほかの検査（生年月日 19800101）は、生年月日の条件で出ない
  const others = await page.request.get(`/api/studies?${new URLSearchParams({ birth: "1975-05-10" })}`);
  expect(((await others.json()) as { studies: { patientId: string }[] }).studies.every((s) => s.patientId.startsWith("JP-TEST-IT2"))).toBe(true);

  // 大文字と小文字：Orthanc の QIDO-RS の答えと、BFF の答えを並べて残す（仕様の 3.1 に書く）
  const caseCheck = {
    descLower: { orthanc: await raw({ StudyDescription: "*chest*" }), bff: await found({ desc: "chest" }) },
    accessionLower: { orthanc: await raw({ AccessionNumber: "*adv-0001*" }), bff: await found({ accession: "adv-0001" }) },
  };
  observe("qido.advancedCase", caseCheck);
  for (const [key, v] of Object.entries(caseCheck)) {
    // Orthanc 26.9.1 の QIDO-RS は、大文字と小文字を区別しない（2026-10-21 に測った。仕様の 3.1 はこれを前提に書いた）
    expect.soft(v.orthanc, `${key}：Orthanc が大文字と小文字を区別するようになった`).toEqual(["adv-d"]);
    // BFF は Orthanc が合うとした検査を落とさない
    expect.soft(v.bff, key).toEqual(v.orthanc);
  }
});

test("12 画像単位の DICOM タグ：本物の Orthanc の QIDO-RS で画像の並びを引き、WADO-RS の metadata で 1 枚の値を読む（2026-10-21）", async () => {
  const { page } = admin;
  const base = `/api/studies/${A.studyInstanceUid}/series/${A.seriesInstanceUid}/instances`;
  const listRes = await page.request.get(base);
  expect(listRes.status()).toBe(200);
  const { instances } = (await listRes.json()) as { instances: { sopInstanceUid: string; instanceNumber: string }[] };
  // 送った 3 枚が、画像の番号の順に並ぶ。画面へ返すのは選ぶのに要る値だけ
  expect(instances.map((i) => i.sopInstanceUid)).toEqual(A.sopInstanceUids);
  expect(instances.map((i) => i.instanceNumber)).toEqual(["1", "2", "3"]);
  expect(Object.keys(instances[0]!).sort()).toEqual(["instanceNumber", "numberOfFrames", "sopClassUid", "sopInstanceUid"]);

  // 1 枚の値の全部。その画像の SOPInstanceUID と画像の番号が入り、ほかの画像のものではない
  const second = A.sopInstanceUids[1]!;
  const valuesRes = await page.request.get(`${base}/${second}/values`);
  expect(valuesRes.status()).toBe(200);
  const { values } = (await valuesRes.json()) as { values: { tag: string; value: string }[] };
  const value = (tag: string) => values.find((v) => v.tag === tag)?.value;
  expect(value("0008,0018")).toBe(second);
  expect(value("0020,0013")).toBe("2");
  expect(value("0010,0020")).toBe(A.patientId);
  // 別のシリーズの下の画像としては返さない
  expect((await page.request.get(`/api/studies/${A.studyInstanceUid}/series/1.2.3/instances/${second}/values`)).status()).toBe(404);

  // Orthanc の画像の単位の QIDO-RS が、検査・シリーズの UID と患者 ID を返すか（BFF が確かめに使う）を記録する
  const rows = await orthancJson<Record<string, unknown>[]>(
    `dicom-web/studies/${A.studyInstanceUid}/series/${A.seriesInstanceUid}/instances?includefield=00100020`,
  );
  const keys = Object.keys(rows[0] ?? {}).filter((k) => ["0020000D", "0020000E", "00100020"].includes(k));
  observe("qido.instanceKeys", keys);
  // BFF は、この 3 つがあることを前提に、求めた検査・シリーズの画像だけを返す（2026-10-21 に Orthanc 26.9.1 で測った）
  expect.soft(keys.sort(), "Orthanc の画像の単位の QIDO-RS が、検査・シリーズの UID か患者 ID を返さなくなった").toEqual(["0020000D", "0020000E", "00100020"].sort());
});

// 13（検査を 1001 件足す）より前に流す
test("14 画像ごとの主なタグ：ISO 2022 IR 87 の検査の氏名と検査名が、本物の Orthanc の WADO-RS の metadata から崩れずに返る（2026-10-23）", async () => {
  test.setTimeout(120_000);
  const { page } = admin;
  // 文字の集合が ISO 2022 IR 87（JIS X 0208）の、架空の患者の検査
  const J = syntheticStudy("study-jp", 23, 2, {
    charset: "\\ISO 2022 IR 87",
    patientName: "ITEST^HANAKO=試験^花子=しけん^はなこ",
    studyDescription: "頭部単純",
  });
  writeDumps(J);
  await storescuToOrthanc(J.batch);
  await waitFor(`Orthanc に ${J.batch} が入る`, () => lookupStudy(J.studyInstanceUid), (ids) => ids.length === 1);

  const sop = J.sopInstanceUids[1]!;
  const res = await page.request.get(`/api/studies/${J.studyInstanceUid}/series/${J.seriesInstanceUid}/instances/${sop}/tags`);
  expect(res.status()).toBe(200);
  const { tags } = (await res.json()) as { tags: { tag: string; name: string; vr: string; value: string | null }[] };
  // INSTANCE_TAGS（playwright.config.ts）の順に、設定のタグだけ
  expect(tags.map((t) => t.tag)).toEqual(["0020,0013", "0008,0018", "0010,0010", "0008,1030", "0028,0010", "0018,0050", "0002,0010"]);
  const byTag = (tag: string) => tags.find((t) => t.tag === tag)!;
  expect(byTag("0020,0013")).toMatchObject({ name: "画像番号", value: "2" });
  expect(byTag("0008,0018").value).toBe(sop);
  // 漢字とかなが崩れない（BFF は文字コードを読み替えず、Orthanc が直した値をそのまま返す）
  expect(byTag("0010,0010")).toMatchObject({ name: "氏名", vr: "PN", value: "ITEST^HANAKO=試験^花子=しけん^はなこ" });
  expect(byTag("0008,1030")).toMatchObject({ name: "検査名", value: "頭部単純" });
  expect(byTag("0028,0010").value).toBe("8");
  // 画像に無いタグは null
  expect(byTag("0018,0050")).toMatchObject({ vr: "", value: null });
  // ファイルのメタ情報（転送構文）が WADO-RS の metadata に入るかを記録する（既定の一覧に入れなかった理由）
  observe("metadata.transferSyntax", byTag("0002,0010"));
  // 設定に無いタグ（患者ID）は返らない
  expect(JSON.stringify(tags)).not.toContain(J.patientId);

  // Orthanc の WADO-RS の metadata の答えの、文字の集合と日本語の値（モックの見本に写す）
  const metadata = await orthancJson<Record<string, { vr: string; Value?: unknown[] }>[]>(
    `dicom-web/studies/${J.studyInstanceUid}/series/${J.seriesInstanceUid}/instances/${sop}/metadata`,
  );
  observe("metadata.iso2022", {
    "00080005": metadata[0]?.["00080005"],
    "00081030": metadata[0]?.["00081030"],
    "00100010": metadata[0]?.["00100010"],
  });

  // 画面：サムネイルから開き、主なタグの表に日本語の氏名が出る
  await openStudy(page, J);
  await page.getByTestId("series-open").click();
  const table = page.getByTestId("series-images").getByTestId("instance-tags");
  await expect(table.locator('tr[data-tag="0010,0010"]')).toContainText("試験^花子=しけん^はなこ");
  await expect(table.locator('tr[data-tag="0008,1030"]')).toContainText("頭部単純");
});

test("13 上限を超えたとき：検査が 1000 件を超えても、いちばん新しい検査が一覧に出て、件数は「以上」になる（2026-10-21）", async () => {
  // 最後の試験に置く（Orthanc に 1000 件を超える検査を足すので、ほかの試験の一覧に混ざらないように）
  test.setTimeout(600_000);
  const { page } = admin;
  // 古い検査（2020-01-01 から 1 日に 1 件、1001 日分）を先に入れ、いちばん新しい検査を最後に入れる。
  // Orthanc の REST（tools/create-dicom）で 1 枚ずつ作る（架空の患者。画像は無い）
  const BULK_DAYS = 1001;
  const bulk = Array.from({ length: BULK_DAYS }, (_, i) => ({
    uid: newUid(),
    date: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10).replaceAll("-", ""),
  }));
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const latest = { uid: newUid(), date: today };
  const create = async (s: { uid: string; date: string }, time: string) => {
    const res = await orthanc("tools/create-dicom", {
      method: "POST",
      contentType: "application/json",
      body: JSON.stringify({
        Force: true,
        Tags: {
          SpecificCharacterSet: "ISO_IR 192",
          PatientID: "JP-TEST-IT90",
          PatientName: "ITEST^LIMIT",
          StudyInstanceUID: s.uid,
          SeriesInstanceUID: newUid(),
          SOPInstanceUID: newUid(),
          StudyDate: s.date,
          StudyTime: time,
          Modality: "CT",
        },
      }),
    });
    expect(res.status, `検査 ${s.date} を作る`).toBe(200);
    await res.body?.cancel();
  };
  for (let i = 0; i < bulk.length; i += 8) await Promise.all(bulk.slice(i, i + 8).map((s) => create(s, "090000")));
  await create(latest, "235959");
  const total = (await orthancJson<{ CountStudies: number }>("statistics")).CountStudies;
  expect(total).toBeGreaterThan(1001);

  // Orthanc の QIDO-RS が limit で切ったときに返す順と、続きの知らせ（Warning 299）を記録する（PS3.18 8.3.4.4 は順を決めていない）
  const rawRes = await orthanc("dicom-web/studies?limit=1000");
  expect(rawRes.status).toBe(200);
  const raw = (await rawRes.json()) as Record<string, { Value?: unknown[] }>[];
  const rawUids = raw.map((r) => String(r["0020000D"]?.Value?.[0] ?? ""));
  const rawDates = raw.map((r) => String(r["00080020"]?.Value?.[0] ?? ""));
  const sortedDesc = [...rawDates].sort().reverse();
  const askMore = await orthanc("dicom-web/studies?limit=1001");
  const askMoreRows = ((await askMore.json()) as unknown[]).length;
  observe("qido.limitOrder", {
    total,
    returned: raw.length,
    warning: rawRes.headers.get("warning"),
    warningLimit1001: askMore.headers.get("warning"),
    returnedLimit1001: askMoreRows,
    includesLatest: rawUids.includes(latest.uid),
    newestFirst: rawDates.join() === sortedDesc.join(),
    oldestFirst: rawDates.join() === [...sortedDesc].reverse().join(),
    firstDates: rawDates.slice(0, 3),
    lastDates: rawDates.slice(-3),
  });

  // BFF：いちばん新しい検査が一覧の先頭に出る。件数は確定にしない。新しい順の 1000 件（古い側の検査だけが外れる）
  const res = await page.request.get("/api/studies");
  expect(res.status()).toBe(200);
  const list = (await res.json()) as { count: { count: number; exact: boolean }; studies: { studyInstanceUid: string }[] };
  expect(list.studies[0]?.studyInstanceUid).toBe(latest.uid);
  expect(list.count).toEqual({ count: 1000, exact: false });
  const shown = new Set(list.studies.map((s) => s.studyInstanceUid));
  const left = total - 1000;
  expect(bulk.slice(0, left).filter((s) => shown.has(s.uid)), "外れるのは古い側の検査だけ").toEqual([]);
  expect(bulk.slice(left).filter((s) => !shown.has(s.uid)), "新しい側の検査は全部出る").toEqual([]);

  // 範囲の中が上限に届かなければ、件数は確定
  const january = await page.request.get(`/api/studies?${new URLSearchParams({ date: "range", from: "2020-01-01", to: "2020-01-31" })}`);
  const jan = (await january.json()) as { count: { count: number; exact: boolean }; studies: { studyInstanceUid: string }[] };
  expect(jan.count).toEqual({ count: 31, exact: true });
  expect(jan.studies.map((s) => s.studyInstanceUid).sort()).toEqual(bulk.slice(0, 31).map((s) => s.uid).sort());
});


test("15 HL7 の A40：患者 ID を替え、Study・Series・SOP の UID を保ち、元の検査を残さない", async () => {
  const study = syntheticStudy("hl7-a40", 50, 2);
  const temporaryId = study.patientId;
  const finalId = "JP-TEST-HL7-FINAL";
  writeDumps(study);
  await storescuToOrthanc(study.batch);
  const [oldId] = await waitFor("HL7 の試験の検査が入る", () => lookupStudy(study.studyInstanceUid), (ids) => ids.length === 1);
  const controlId = `HL7-${newUid().slice(-16)}`;
  const token = process.env.ITEST_HL7_TOKEN;
  if (!token) {
    throw new Error("試験の HL7 token が無い");
  }
  const message = [
    `MSH|^~\\&|TEST|TEST|BFF|TEST|20261024120000||ADT^A40^ADT_A39|${controlId}|P|2.3.1`,
    `PID|1||${finalId}^^^RIS_EMU^PI||ITEST^FINAL`,
    `MRG|${temporaryId}^^^RIS_EMU^PI`,
    "",
  ].join("\r");
  // fetch の要求のヘッダーを試験の報告に出さない（token は試験のたびに作る）。
  const response = await fetch(`${bffUrl}/api/hl7/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ peer: "192.0.2.1", message: Buffer.from(message).toString("base64") }),
    signal: AbortSignal.timeout(60000),
  });
  expect(response.status).toBe(200);
  const body = await response.json() as {
    ack: string;
  };
  expect(Buffer.from(body.ack, "base64").toString()).toContain(`MSA|AA|${controlId}|`);
  const [newId] = await lookupStudy(study.studyInstanceUid);
  expect(newId).toBeTruthy();
  expect(newId).not.toBe(oldId);
  expect((await orthanc(`studies/${oldId}`)).status).toBe(404);
  const current = await orthancJson<{
    MainDicomTags: {
      StudyInstanceUID: string;
    };
    PatientMainDicomTags: {
      PatientID: string;
    };
    Series: string[];
  }>(`studies/${newId}`);
  expect(current.MainDicomTags.StudyInstanceUID).toBe(study.studyInstanceUid);
  expect(current.PatientMainDicomTags.PatientID).toBe(finalId);
  const series = await orthancJson<{
    MainDicomTags: {
      SeriesInstanceUID: string;
    };
  }>(`series/${current.Series[0]}`);
  expect(series.MainDicomTags.SeriesInstanceUID).toBe(study.seriesInstanceUid);
  const instances = await orthancJson<{
    MainDicomTags: {
      SOPInstanceUID: string;
    };
  }[]>(`studies/${newId}/instances`);
  expect(instances.map((i) => i.MainDicomTags.SOPInstanceUID).sort()).toEqual([...study.sopInstanceUids].sort());
  expect(await orthancJson("tools/find", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ Level: "Study", Query: { PatientID: temporaryId }, Expand: false })
  })).toEqual([]);
  const rows = readAudit().filter((r) => r.action === "hl7" && r.detail.controlId === controlId);
  expect(rows.map((r) => `${r.detail.event}:${r.outcome}`)).toEqual([
    "received:success",
    "request:success",
    "dispatch:success",
    "result:success",
    "ack:success"
  ]);
  expect(rows[3]!.detail).toMatchObject({
    writeId: rows[1]!.detail.writeId,
    oldOrthancId: oldId,
    newOrthancId: newId,
    before: expect.arrayContaining([expect.objectContaining({ PatientID: temporaryId })]),
    after: expect.arrayContaining([expect.objectContaining({ PatientID: finalId })])
  });
  const tags = await orthancJson<Record<string, Record<string, string>>>(`studies/${newId}/instances-tags?simplify`);
  expect(Object.values(tags)).toHaveLength(study.sopInstanceUids.length);
  const actualUids = Object.values(tags).map(t => [t.StudyInstanceUID, t.SeriesInstanceUID, t.SOPInstanceUID].join("|"));
  const expectedUids = study.sopInstanceUids.map(sop => [study.studyInstanceUid, study.seriesInstanceUid, sop].join("|"));
  expect(actualUids.sort()).toEqual(expectedUids.sort());
  for (const t of Object.values(tags))
    expect(t).toMatchObject({
      PatientID: finalId,
      PatientName: "ITEST^FINAL",
      PatientBirthDate: study.patientBirthDate,
      PatientSex: study.patientSex,
      AccessionNumber: study.accessionNumber
    });
});

// 既存の取り込み（beforeAll、詳細条件、日本語タグ）はすべて新しい UID を1回送る。
// 重複の送り直しが無視されることを期待する場面は無い。OverwriteInstances はこの試験の Orthanc だけに設定する。
async function sendHl7(kind: "A40" | "A08" | "ORM", patientId: string, fields: {
  name?: string;
  birth?: string;
  old?: string;
  uid?: string;
  accession?: string;
  control?: "NW" | "CA" | "DC" | "XO";
} = {}) {
  const token = process.env.ITEST_HL7_TOKEN;
  if (!token) {
    throw Error("試験の HL7 token が無い");
  }
  const controlId = `IT-${newUid().slice(-16)}`;
  const msh = [
    "MSH",
    "^~\\&",
    "ITEST",
    "ITEST",
    "BFF",
    "ITEST",
    "20261024120000",
    "",
    kind === "ORM" ? "ORM^O01^ORM_O01" : `ADT^${kind}^${kind === "A40" ? "ADT_A39" : "ADT_A01"}`,
    controlId,
    "P",
    "2.3.1",
    "",
    "",
    "",
    "",
    "",
    "UNICODE UTF-8"
  ].join("|");
  const segments = [
    msh,
    `PID|1||${patientId}^^^RIS_EMU^PI||${fields.name ?? ""}||${fields.birth ?? ""}|`
  ];
  if (kind === "A40") {
    segments.push(`MRG|${fields.old}^^^RIS_EMU^PI`);
  }
  if (kind === "ORM") {
    const obr = Array<string>(19).fill("");
    obr[0] = "OBR";
    obr[18] = fields.accession!;
    segments.push(`ORC|${fields.control ?? "NW"}`, obr.join("|"), `ZDS|${fields.uid}`);
  }
  const response = await fetch(`${bffUrl}/api/hl7/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      peer: "192.0.2.1",
      message: Buffer.from(segments.join("\r") + "\r").toString("base64")
    }),
    signal: AbortSignal.timeout(130000)
  });
  expect(response.status).toBe(200);
  return Buffer.from((await response.json() as {
    ack: string;
  }).ack, "base64").toString();
}
async function hl7Tags(study: ReturnType<typeof syntheticStudy>) {
  const ids = await lookupStudy(study.studyInstanceUid);
  expect(ids).toHaveLength(1);
  const tags = Object.values(await orthancJson<Record<string, Record<string, string>>>(`studies/${ids[0]}/instances-tags?simplify`));
  expect(tags).toHaveLength(study.sopInstanceUids.length);
  const actualUids = tags.map(t => [t.StudyInstanceUID, t.SeriesInstanceUID, t.SOPInstanceUID].join("|"));
  const expectedUids = study.sopInstanceUids.map(sop => [study.studyInstanceUid, study.seriesInstanceUid, sop].join("|"));
  expect(actualUids.sort()).toEqual(expectedUids.sort());
  return tags;
}
test("16 HL7 A08 と ORM は全画像の UID を保ち値を揃える", async () => {
  const study = syntheticStudy("hl7-a08-orm", 51, 3, { accessionNumber: "" });
  writeDumps(study);
  await storescuToOrthanc(study.batch);
  await waitFor("HL7 の検査", () => lookupStudy(study.studyInstanceUid), ids => ids.length === 1);
  const [originalId] = await lookupStudy(study.studyInstanceUid);
  expect(await sendHl7("A08", study.patientId, { name: "ITEST^UPDATED" })).toContain("MSA|AA|");
  for (const t of await hl7Tags(study))
    expect(t).toMatchObject({
      PatientID: study.patientId,
      PatientName: "ITEST^UPDATED",
      PatientBirthDate: study.patientBirthDate,
      PatientSex: study.patientSex,
      AccessionNumber: ""
    });
  expect(await sendHl7("ORM", study.patientId, { uid: study.studyInstanceUid, accession: "IT-HL7-ORM" })).toContain("MSA|AA|");
  for (const t of await hl7Tags(study))
    expect(t).toMatchObject({
      PatientID: study.patientId,
      PatientName: "ITEST^UPDATED",
      PatientBirthDate: study.patientBirthDate,
      PatientSex: study.patientSex,
      AccessionNumber: "IT-HL7-ORM"
    });
  expect(await lookupStudy(study.studyInstanceUid)).toEqual([originalId]);
});
test("17 HL7 A40 の替え先が存在：違う属性は両方を保ち、同じ属性は統合する", async () => {
  const source = syntheticStudy("hl7-merge-source", 52, 2, { patientName: "SOURCE^PATIENT", patientBirthDate: "19990101" });
  const target = syntheticStudy("hl7-merge-target", 53, 3, { patientName: "TARGET^PATIENT", patientBirthDate: "19800101" });
  for (const study of [source, target]) {
    writeDumps(study);
    await storescuToOrthanc(study.batch);
    await waitFor("HL7 の検査", () => lookupStudy(study.studyInstanceUid), ids => ids.length === 1);
  }
  const [oldId] = await lookupStudy(source.studyInstanceUid);
  const beforeSource = await hl7Tags(source);
  const beforeTarget = await hl7Tags(target);
  const conflictingAck = await sendHl7("A40", target.patientId, {
    old: source.patientId, name: target.patientName, birth: "20000101",
  });
  expect(conflictingAck).toContain("MSA|AE|");
  expect(await hl7Tags(source)).toEqual(beforeSource);
  expect(await hl7Tags(target)).toEqual(beforeTarget);
  expect(await sendHl7("A40", target.patientId, { old: source.patientId, name: target.patientName })).toContain("MSA|AA|");
  for (const t of await hl7Tags(source))
    expect(t).toMatchObject({
      PatientID: target.patientId,
      PatientName: target.patientName,
      PatientBirthDate: target.patientBirthDate,
      PatientSex: target.patientSex,
      AccessionNumber: source.accessionNumber
    });
  expect(await hl7Tags(target)).toEqual(beforeTarget);
  expect((await orthanc(`studies/${oldId}`)).status).toBe(404);
  expect(await orthancJson("tools/find", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ Level: "Study", Query: { PatientID: source.patientId }, Expand: false })
  })).toEqual([]);
});

test("18 HL7 照合の後に仮の患者 ID で届いた画像を、統合した検査にまとめ、CA で受付番号を外す（2026-10-25）", async () => {
  const token = process.env.ITEST_HL7_TOKEN;
  if (!token) {
    throw Error("試験の HL7 token が無い");
  }
  const first = syntheticStudy("hl7-case6-first", 54, 2, { accessionNumber: "", patientName: "UNKNOWN^MALE" });
  writeDumps(first);
  await storescuToOrthanc(first.batch);
  await waitFor("仮の患者の検査", () => lookupStudy(first.studyInstanceUid), ids => ids.length === 1);
  const finalId = "JP-TEST-HL7-CASE6";
  expect(await sendHl7("A40", finalId, { old: first.patientId, name: "ITEST^CASE6", birth: "19700101" })).toContain("MSA|AA|");
  expect(await sendHl7("ORM", finalId, { uid: first.studyInstanceUid, accession: "IT-CASE6-1" })).toContain("MSA|AA|");
  // 同じ Study に、仮の患者 ID のまま 2 つめのシリーズが届く（Orthanc では別の検査になる）
  const late = {
    ...syntheticStudy("hl7-case6-late", 54, 2, { accessionNumber: "", patientName: "UNKNOWN^MALE" }),
    studyInstanceUid: first.studyInstanceUid
  };
  writeDumps(late);
  await storescuToOrthanc(late.batch);
  await waitFor("同じ UID の検査が 2 件", () => lookupStudy(first.studyInstanceUid), ids => ids.length === 2);
  const sweep = async () => {
    const response = await fetch(`${bffUrl}/api/hl7/sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(130000)
    });
    expect(response.status).toBe(200);
    return await response.json() as { ok: boolean; count: number; skipped: number; blocked?: string };
  };
  // 届き終える（試験の Orthanc の StableAge は 2 秒）までは書き換えない
  const result = await waitFor("見回りで書き換わる", sweep, r => r.count === 1, 30_000);
  expect(result).toMatchObject({ ok: true, count: 1, skipped: 0 });
  const ids = await lookupStudy(first.studyInstanceUid);
  expect(ids).toHaveLength(1);
  const tags = Object.values(await orthancJson<Record<string, Record<string, string>>>(`studies/${ids[0]}/instances-tags?simplify`));
  expect(tags).toHaveLength(4);
  const uids = tags.map(t => [t.StudyInstanceUID, t.SeriesInstanceUID, t.SOPInstanceUID].join("|")).sort();
  const expected = [first, late].flatMap(s => s.sopInstanceUids.map(sop => [first.studyInstanceUid, s.seriesInstanceUid, sop].join("|"))).sort();
  expect(uids).toEqual(expected);
  for (const t of tags)
    expect(t).toMatchObject({ PatientID: finalId, PatientName: "ITEST^CASE6", PatientBirthDate: "19700101", AccessionNumber: "IT-CASE6-1" });
  expect(await sweep()).toMatchObject({ count: 0 });

  // RAD-13 の CA：検査と画像を残し、受付番号を外す
  expect(await sendHl7("ORM", finalId, { uid: first.studyInstanceUid, accession: "IT-CASE6-1", control: "CA" })).toContain("MSA|AA|");
  const [afterCancel] = await lookupStudy(first.studyInstanceUid);
  const cancelled = Object.values(await orthancJson<Record<string, Record<string, string>>>(`studies/${afterCancel}/instances-tags?simplify`));
  expect(cancelled).toHaveLength(4);
  for (const t of cancelled)
    expect(t).toMatchObject({ PatientID: finalId, AccessionNumber: "" });
});

/** Orthanc のログに残った、付け替えの印で C-STORE を断った行の数（deploy/orthanc/tsunagi-lock.lua） */
const lockRefusals = async () => (await compose(["logs", "--no-color", "orthanc"])).split("\n").filter(l => l.includes("tsunagi-lock: refused")).length;
/** 試験から Orthanc の REST へ、架空の患者の画像を 1 枚入れる（REST・STOW-RS で届く画像の代わり。付け替えの印では断られない） */
async function restCreate(tags: Record<string, string>) {
  return orthancJson<{ ID: string }>("tools/create-dicom", {
    method: "POST",
    contentType: "application/json",
    body: JSON.stringify({ Tags: { SOPClassUID: "1.2.840.10008.5.1.4.1.1.7", Modality: "OT", SpecificCharacterSet: "ISO_IR 192", ...tags }, Force: true })
  });
}

test("20 付け替えの印：期限の切れていない印のある検査と同じ StudyInstanceUID の C-STORE を、Orthanc の Lua が断る（2026-10-25）", async () => {
  const study = syntheticStudy("lock-first", 56, 1);
  writeDumps(study);
  await storescuToOrthanc(study.batch);
  const [id] = await waitFor("印の試験の検査", () => lookupStudy(study.studyInstanceUid), ids => ids.length === 1);
  const lock = (until: number) => orthanc(`studies/${id}/metadata/TsunagiLock`, { method: "PUT", body: String(until), contentType: "text/plain" });
  const instances = async () => (await orthancJson<unknown[]>(`studies/${id}/instances`)).length;

  // 印の間：同じ Study の新しいシリーズを送ると、storescu は失敗し、Orthanc には入らない
  expect((await lock(Math.floor(Date.now() / 1000) + 60)).status).toBe(200);
  const refusedBefore = await lockRefusals();
  const more = { ...syntheticStudy("lock-more", 56, 2), studyInstanceUid: study.studyInstanceUid };
  writeDumps(more);
  await expect(storescuToOrthanc(more.batch)).rejects.toThrow();
  expect(await instances()).toBe(1);
  await waitFor("Orthanc のログに断った行が残る", lockRefusals, n => n > refusedBefore, 10_000);

  // 期限の切れた印では断らない
  expect((await lock(Math.floor(Date.now() / 1000) - 5)).status).toBe(200);
  await storescuToOrthanc(more.batch);
  expect(await instances()).toBe(3);

  // 印を外した後の送り直しも受ける（同じ UID の送り直しは上書き）
  expect((await lock(Math.floor(Date.now() / 1000) + 60)).status).toBe(200);
  expect((await orthanc(`studies/${id}/metadata/TsunagiLock`, { method: "DELETE" })).status).toBe(200);
  await storescuToOrthanc(more.batch);
  expect(await instances()).toBe(3);
});

// HL7 の書き換えを部分反映で止めたまま終わるので、HL7 を使う試験の最後（21 の前。21 は人が解いてから流す）に置く
test("19 HL7 見回りの書き換えの最中の C-STORE は断られ、REST で届いた画像は消えずに残って部分反映で止まる（2026-10-25）", async () => {
  const token = process.env.ITEST_HL7_TOKEN;
  if (!token) {
    throw Error("試験の HL7 token が無い");
  }
  const first = syntheticStudy("hl7-race-first", 55, 2, { accessionNumber: "", patientName: "UNKNOWN^MALE" });
  writeDumps(first);
  await storescuToOrthanc(first.batch);
  await waitFor("仮の患者の検査", () => lookupStudy(first.studyInstanceUid), ids => ids.length === 1);
  const finalId = "JP-TEST-HL7-RACE";
  expect(await sendHl7("A40", finalId, { old: first.patientId, name: "ITEST^RACE", birth: "19700101" })).toContain("MSA|AA|");
  // 統合の後に、仮の患者 ID のまま 2 つめのシリーズが届く
  const late = { ...syntheticStudy("hl7-race-late", 55, 1, { accessionNumber: "", patientName: "UNKNOWN^MALE" }), studyInstanceUid: first.studyInstanceUid };
  writeDumps(late);
  await storescuToOrthanc(late.batch);
  await waitFor("同じ UID の検査が 2 件", () => lookupStudy(first.studyInstanceUid), ids => ids.length === 2);
  // 見回りが書き換えの仕事を作った直後に、仮の患者 ID の 3 つめのシリーズを C-STORE で送り（付け替えの印で断られる）、
  // 4 つめのシリーズを REST で入れる（印では止まらない）
  const during = { ...syntheticStudy("hl7-race-during", 55, 1, { accessionNumber: "", patientName: "UNKNOWN^MALE" }), studyInstanceUid: first.studyInstanceUid };
  writeDumps(during);
  const restSop = newUid();
  let cstore = "";
  gate.onceAfterModify(async () => {
    cstore = await storescuToOrthanc(during.batch).then(() => "stored", () => "failed");
    await restCreate({
      PatientID: first.patientId, PatientName: "UNKNOWN^MALE", PatientBirthDate: first.patientBirthDate, PatientSex: first.patientSex,
      StudyInstanceUID: first.studyInstanceUid, SeriesInstanceUID: newUid(), SOPInstanceUID: restSop
    });
  });
  const refusedBefore = await lockRefusals();
  const sweep = async () => {
    const response = await fetch(`${bffUrl}/api/hl7/sweep`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(130000)
    });
    expect(response.status).toBe(200);
    return await response.json() as { ok: boolean; count: number; skipped: number; blocked?: string };
  };
  // 届き終える（StableAge は 2 秒）までは書き換えない。書き換えれば、REST で最中に届いた画像のために部分反映で止まる
  const result = await waitFor("見回りが書き換えを試す", sweep, r => r.count > 0 || r.blocked !== undefined, 60_000);
  expect(result).toMatchObject({ ok: true, count: 0, blocked: "画像の一部だけが書き換わった" });
  // 最中の C-STORE は、付け替えの印で断られた（送り手には失敗が返り、Orthanc には入っていない）
  expect(cstore).toBe("failed");
  expect(await lockRefusals()).toBeGreaterThan(refusedBefore);

  const sops = async () => {
    const tags = (await Promise.all((await lookupStudy(first.studyInstanceUid)).map(id =>
      orthancJson<Record<string, Record<string, string>>>(`studies/${id}/instances-tags?simplify`)))).flatMap(t => Object.values(t));
    return tags.map(t => ({ sop: t.SOPInstanceUID, patientId: t.PatientID }));
  };
  const now = await sops();
  expect(now.some(i => i.sop === during.sopInstanceUids[0])).toBe(false);
  // REST で最中に届いた画像は、仮の患者 ID のまま Orthanc に残っている（Orthanc に元を消させないため）
  expect(now.filter(i => i.sop === restSop)).toEqual([{ sop: restSop, patientId: first.patientId }]);
  // どの画像も失っていない（書き換えた画像は統合した先にあり、元の画像は名指しで消したか、そのまま残っている）
  for (const sop of [...first.sopInstanceUids, ...late.sopInstanceUids])
    expect(now.some(i => i.sop === sop)).toBe(true);
  const results = readAudit().filter(r => r.action === "hl7" && r.detail.type === "sweep" && r.detail.event === "result"
    && r.studyInstanceUid === first.studyInstanceUid);
  expect(results.at(-1)).toMatchObject({ outcome: "failed", detail: { partial: true, state: "Success" } });
  expect(results.at(-1)!.detail.foreignCopies).toBeUndefined();

  // 書き換えが終われば印は外れ、断られた C-STORE の送り直しは保存される（仮の患者 ID のまま、後から届いた画像として残る）
  await storescuToOrthanc(during.batch);
  expect((await sops()).filter(i => i.sop === during.sopInstanceUids[0])).toEqual([{ sop: during.sopInstanceUids[0], patientId: first.patientId }]);
  // 次の見回りも、人が解くまで書き換えない
  expect(await sweep()).toMatchObject({ count: 0, blocked: "結果の分からない書き換えがある" });
});

test("21 HL7 A40：書き換えた画像が元を消す前に REST で同じ UID の別の画像に置き換わると、ModifiedFrom が合わず、元を消さずに部分反映で止まる（2026-10-25）", async ({ browser }) => {
  test.setTimeout(180_000);
  // 19 の部分反映を、管理者が /api/hl7/resolve で解く（解くまで HL7 の書き換えは止まったまま）
  const pending = readAudit().filter(r => r.action === "hl7" && r.detail.event === "result" && r.detail.partial === true).at(-1);
  expect(pending).toBeTruthy();
  const fresh = await newContext(browser);
  try {
    const user = adminUser();
    await submitLogin(fresh.page, user.username, user.changed);
    await expect(fresh.page).toHaveURL(`${bffUrl}/`);
    const resolved = await fresh.page.request.post("/api/hl7/resolve", {
      headers: { origin: bffUrl, "x-csrf-token": latestCsrfToken() },
      data: { writeId: pending!.detail.writeId, note: "結合の試験：19 の部分反映を確かめた" }
    });
    expect(resolved.status()).toBe(200);
  } finally {
    await fresh.context.close();
  }

  const study = syntheticStudy("hl7-foreign-copy", 57, 2);
  writeDumps(study);
  await storescuToOrthanc(study.batch);
  const [oldId] = await waitFor("仮の患者の検査", () => lookupStudy(study.studyInstanceUid), ids => ids.length === 1);
  const finalId = "JP-TEST-HL7-FOREIGN";
  // 仕事が写し終えた後、BFF が元を消す前に、統合した先の患者 ID・同じ値・同じ UID で、中身の違う画像を REST で入れる
  // （OverwriteInstances で写しが置き換わり、ModifiedFrom が無くなる）
  const [sop] = study.sopInstanceUids;
  gate.onceJobSucceeded(async () => {
    await restCreate({
      PatientID: finalId, PatientName: "ITEST^FOREIGN", PatientBirthDate: "19700101", PatientSex: study.patientSex,
      AccessionNumber: study.accessionNumber, StudyInstanceUID: study.studyInstanceUid, SeriesInstanceUID: study.seriesInstanceUid,
      SOPInstanceUID: sop!, InstitutionName: "ITEST FOREIGN"
    });
  });
  expect(await sendHl7("A40", finalId, { old: study.patientId, name: "ITEST^FOREIGN", birth: "19700101" })).toContain("MSA|AE|");
  // 元の検査は消さずに残る（どの画像も失っていない）
  const source = await orthancJson<Record<string, Record<string, string>>>(`studies/${oldId}/instances-tags?simplify`);
  expect(Object.values(source).map(t => t.SOPInstanceUID).sort()).toEqual([...study.sopInstanceUids].sort());
  expect(Object.values(source).every(t => t.PatientID === study.patientId)).toBe(true);
  const result = readAudit().filter(r => r.action === "hl7" && r.detail.event === "result" && r.studyInstanceUid === study.studyInstanceUid).at(-1);
  expect(result).toMatchObject({ outcome: "failed", detail: { partial: true, foreignCopies: true, state: "Success" } });
  // 付け替えの印は外れている
  expect((await orthanc(`studies/${oldId}/metadata/TsunagiLock`)).status).toBe(404);
});
