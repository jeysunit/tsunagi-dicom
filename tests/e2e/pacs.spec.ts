import { expect, test, type Page } from "@playwright/test";

// 段 4 の画面（docs/spec.md の 3.3・3.4）：受け取りの記録・機器の一覧と C-ECHO・送る。
// 検証モード（AUTH_MODE=dev）とモックの Orthanc に対して流す。この試験のサーバーは DEV_ALLOW_WRITE=false（既定）なので、
// 送る操作は止まることを確かめる。送るの一巡りは、AUTH_MODE=local のサーバー（tests/e2e/local-auth.spec.ts）で確かめる。

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

async function asRole(page: Page, label: "管理者" | "医師" | "技師" | "閲覧") {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

// 期待の変更（文言）：画面の言葉を docs/spec.md の 2.2 の用語集に合わせた（受け取り→受信一覧・取り込み→インポート・
// 一覧で開く→検査一覧で表示・つながった→成功（時刻つき）・書き込みは止めている→書き込み：無効など）。確かめる振る舞いは同じ。
test("受け取りの記録：技師は、受け取った検査を新しい順に 1 件 1 行で見られ、REST で入った検査は「インポート」と分かる", async ({ page }) => {
  await asRole(page, "技師");
  await page.getByRole("navigation", { name: "頁" }).getByRole("link", { name: "受信一覧" }).click();
  await expect(page).toHaveURL(/\/received$/);
  const rows = page.getByTestId("received-row");
  await expect(rows).toHaveCount(8);
  // 見本の変更の記録の時刻 20261017T133200 は UTC。TZ=Asia/Tokyo の時刻で出す（docs/spec.md の 3.3）
  await expect(rows.first().getByTestId("received-at")).toHaveText("2026/10/17 22:32:00");
  await expect(rows.first()).toContainText("DTG_SCU");
  await expect(rows.first()).toContainText("JP-TEST-0004");
  await expect(page.getByTestId("received-origin")).toHaveText(["インポート"]);
  // 1 行は 28px ほど
  expect((await rows.first().boundingBox())!.height).toBeLessThanOrEqual(30);
  // 行から検査の一覧へ移れる（患者 ID で絞る）
  await rows.first().getByRole("link", { name: "検査一覧で表示" }).click();
  await expect(page).toHaveURL(/q=JP-TEST-0004/);
  await expect(page.getByTestId("study-count")).toHaveText("2");
});

test("機器：技師は名前と AE タイトルを見て C-ECHO で確かめられ、住所は見えない。管理者には住所が出る", async ({ page }) => {
  await asRole(page, "技師");
  await page.goto("/modalities");
  const rows = page.getByTestId("modality-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("modality-table")).not.toContainText("192.0.2.");
  await page.locator('[data-modality="dtg"]').getByTestId("echo").click();
  // 結果は印と時刻つき（「成功 10:32:05」「失敗 10:32:11（応答なし）」。docs/spec.md の 3.3）
  await expect(page.locator('[data-modality="dtg"]').getByTestId("echo-result")).toHaveText(/^成功 \d{2}:\d{2}:\d{2}$/);
  await page.locator('[data-modality="offline"]').getByTestId("echo").click();
  await expect(page.locator('[data-modality="offline"]').getByTestId("echo-result")).toHaveText(/^失敗 \d{2}:\d{2}:\d{2}（応答なし）$/);

  await asRole(page, "管理者");
  await page.goto("/modalities");
  await expect(page.locator('[data-modality="dtg"]')).toContainText("192.0.2.20:11112");
});

test("医師・閲覧には、受け取り・機器の頁の道が無く、開いても断る", async ({ page }) => {
  for (const role of ["医師", "閲覧"] as const) {
    await asRole(page, role);
    const nav = page.getByRole("navigation", { name: "頁" });
    await expect(nav.getByRole("link", { name: "受信一覧" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "接続先" })).toHaveCount(0);
    await page.goto("/received");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("この画面を表示する権限がありません");
    expect((await page.request.get("/api/receive-log")).status()).toBe(403);
  }
});

test("検証モードで書き込みを止めているときは、送るのボタンが無く、送る要求も断る", async ({ page }) => {
  await asRole(page, "管理者");
  await expect(page.getByTestId("dev-mode-band")).toContainText("書き込み：無効");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  await expect(page.getByTestId("study-detail")).toBeVisible();
  await expect(page.getByTestId("send-open")).toHaveCount(0);
  await expect(page.getByTestId("export-zip")).toHaveCount(0);
  await expect(page.getByTestId("delete-open")).toHaveCount(0);
  const res = await page.request.post(`/api/studies/${STUDY}/send`, {
    data: { modality: "dtg", requestId: crypto.randomUUID() },
    headers: { origin: "http://127.0.0.1:3100" },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toContain("検証モードでは書き込みが無効です");
});
