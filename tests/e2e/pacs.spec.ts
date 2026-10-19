import { expect, test, type Page } from "@playwright/test";

// 段 4 の画面（docs/spec.md の 3.3・3.4）：受け取りの記録・機器の一覧と C-ECHO・送る。
// 検証モード（AUTH_MODE=dev）とモックの Orthanc に対して流す。この試験のサーバーは DEV_ALLOW_WRITE=false（既定）なので、
// 送る操作は止まることを確かめる。送るの一巡りは、AUTH_MODE=local のサーバー（tests/e2e/local-auth.spec.ts）で確かめる。

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

// 役割は管理者と一般の2つ（2026-10-20。docs/spec.md の 3.6）。前の技師で流していた試験は、一般で流す
async function asRole(page: Page, label: "管理者" | "一般") {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

// 期待の変更（文言）：画面の言葉を docs/spec.md の 2.2 の用語集に合わせた（受け取り→受信一覧・取り込み→インポート・
// 一覧で開く→検査一覧で表示・つながった→成功（時刻つき）・書き込みは止めている→書き込み：無効など）。確かめる振る舞いは同じ。
test("受け取りの記録：一般は、受け取った検査を新しい順に 1 件 1 行で見られ、REST で入った検査は「インポート」と分かる", async ({ page }) => {
  await asRole(page, "一般");
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

test("接続先：一般は名称と AE タイトルを見て接続確認ができ、ホスト:ポートは見えない。管理者には出る", async ({ page }) => {
  await asRole(page, "一般");
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

// 期待の変更：前は「医師・閲覧には受け取り・機器の頁の道が無い」。役割を管理者と一般の2つにした（2026-10-20）ので、
// 一般には普段使う頁の道があり、管理者だけの頁（ビューア設定）の道は無く、開いても断ることを見る（docs/spec.md の 3.6）
test("一般の画面には、普段使う頁の道があり、管理者だけの頁の道は出さない。開いても断る", async ({ page }) => {
  await asRole(page, "一般");
  const nav = page.getByRole("navigation", { name: "頁" });
  await expect(nav.getByRole("link", { name: "検査一覧" })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "受信一覧" })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "接続先" })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "ビューア設定" })).toHaveCount(0);
  await page.goto("/admin/viewers");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("管理者のみ利用できます");
  expect((await page.request.get("/api/admin/viewer-defaults")).status()).toBe(403);
  expect((await page.request.get("/api/receive-log")).status()).toBe(200);
  // 管理者には、ビューア設定の道がある
  await asRole(page, "管理者");
  await expect(page.getByRole("navigation", { name: "頁" }).getByRole("link", { name: "ビューア設定" })).toHaveCount(1);
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
