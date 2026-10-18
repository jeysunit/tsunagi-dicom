import { expect, test, type Page } from "@playwright/test";

// 段 2 の検査の一覧（docs/spec.md の 3.1・3.2）：すぐ絞れる見出し・詳細のパネル・状態・ビューアの選び分けと記憶。
// 検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。状態は試験のデータベースに残るので、
// 変えた状態は同じ試験の中で戻し、順に流す。

test.describe.configure({ mode: "serial" });

/** サムネイルの写しがある検査（見本の 1 件目。JP-TEST-0004・2026-04-10・CT） */
const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

async function asRole(page: Page, label: "管理者" | "医師" | "技師" | "閲覧") {
  await page.goto("/");
  const band = page.getByTestId("dev-mode-band");
  const button = band.getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

const rows = (page: Page) => page.getByTestId("study-table").locator("tbody > tr[data-study-uid]");
const row = (page: Page, uid = STUDY) => page.locator(`tr[data-study-uid="${uid}"]`);

/** BFF の /api/viewers/open が移した先（ビューアの URL）。ビューアの宛先（例の名前）へは出ない */
let redirects: string[] = [];

test.beforeEach(async ({ context }) => {
  redirects = [];
  // 移る先への通信は、Playwright の route では止められない（移った後の要求は route を通らない）ので、
  // BFF の答え（302）を受けて移り先を控え、画面には移らずに返す。BFF の側の監査の記録は残る
  await context.route("**/api/viewers/open?**", async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    redirects.push(res.headers()["location"] ?? `status ${res.status()}`);
    await route.fulfill({ status: 200, contentType: "text/plain", body: "opened" });
  });
});

/** 別のタブが開き、BFF がビューアの URL へ移したこと */
async function expectOpened(page: Page, action: () => Promise<void>, url: string | RegExp) {
  const before = redirects.length;
  const popup = page.waitForEvent("popup");
  await action();
  const opened = await popup;
  await expect.poll(() => redirects.length).toBeGreaterThan(before);
  const last = redirects.at(-1)!;
  if (typeof url === "string") expect(last).toBe(url);
  else expect(last).toMatch(url);
  await opened.close();
}

test("すぐ絞れる見出し：期間の指定・モダリティ・横断の検索。絞り込みは頁の URL に残る", async ({ page }) => {
  await asRole(page, "医師");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("date-all")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/?date=range&from=2026-10-17&to=2026-10-17");
  await expect(page.getByTestId("date-range")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("study-count")).toHaveText("4");
  await expect(rows(page)).toHaveCount(4);

  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect(page).toHaveURL(/modality=MR/);

  await page.getByTestId("date-all").click();
  await page.getByTestId("modality-all").click();
  await page.getByTestId("study-search").fill("やまだ");
  await expect(page.getByTestId("study-count")).toHaveText("4");
  await expect(page).toHaveURL(/q=/);
  await page.getByTestId("study-search").fill("JP-TEST-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");

  // 開き直しても同じ絞り込み
  await page.reload();
  await expect(page.getByTestId("study-search")).toHaveValue("JP-TEST-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");

  await page.getByTestId("study-search").fill("該当しない語");
  await expect(page.getByText("合う検査が無い")).toBeVisible();
});

test("一覧の行：氏名（漢字・かな）・和暦と年齢・代表のサムネイル・シリーズ数と画像数", async ({ page }) => {
  await asRole(page, "医師");
  const r = row(page);
  await expect(r).toContainText("試験 髙子");
  await expect(r).toContainText("しけん たかこ");
  await expect(r).toContainText("1960/07/15（昭和35年・65歳・女）");
  await expect(r).toContainText("1 / 4");
  // 写しのある検査はサムネイルが出て、まわりは暗い地
  const img = r.getByTestId("thumbnail");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  // 写しの無い検査は印だけ
  const other = page.getByTestId("study-table").locator(`tbody > tr[data-study-uid]:not([data-study-uid="${STUDY}"])`).last();
  await other.scrollIntoViewIfNeeded();
  await expect(other.getByTestId("thumbnail-missing")).toBeVisible();
  // PN の元の形（^ と =）は画面に出さない
  expect(await page.locator("main").innerText()).not.toContain("^");
});

test("詳細のパネル：行のクリックで開き、検査と患者の情報・UID・シリーズの並び（暗い地）を出す", async ({ page }) => {
  await asRole(page, "医師");
  await row(page).click();
  const detail = page.getByTestId("study-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("患者の情報");
  await expect(detail).toContainText("検査の情報");
  await expect(detail).toContainText("JP-TEST-0004");
  await expect(detail).toContainText("試験 医師");
  await expect(detail.getByTestId("uid-line").first()).toContainText(STUDY);
  const uid = detail.getByTestId("uid-line").first().locator("code");
  await expect(uid).toHaveCSS("font-size", "12px");
  const strip = detail.getByTestId("series-strip");
  await expect(strip.getByTestId("series-item")).toHaveCount(1);
  await expect(strip).toContainText("Chest Axial 5mm");
  await expect(strip).toHaveCSS("background-color", "rgb(18, 20, 23)");
  // 医師には「すべての DICOM の値」が無い
  await expect(detail.getByRole("button", { name: "すべての DICOM の値" })).toHaveCount(0);

  // もう一度押すと閉じる
  await row(page).click();
  await expect(detail).toHaveCount(0);
});

test("状態：技師が検像し、一覧の状態の見出しで絞れる。閲覧には検像のボタンが無い", async ({ page }) => {
  await asRole(page, "技師");
  await row(page).click();
  const inspected = page.getByTestId("state-inspected");
  await expect(inspected).toHaveText("未検像");
  await inspected.click();
  await expect(inspected).toHaveAttribute("aria-pressed", "true");
  await expect(inspected).toHaveText("検像済");
  await expect(row(page)).toContainText("検像済");
  // 技師には読影の状態のボタンが無く、すべての値は見られる
  await expect(page.getByTestId("state-read")).toHaveCount(0);
  await page.getByRole("button", { name: "すべての DICOM の値" }).click();
  await expect(page.getByTestId("all-values")).toContainText("0010,0020");

  await page.getByTestId("status-inspected").click();
  await expect(page.getByTestId("study-count")).toHaveText("1");

  await asRole(page, "閲覧");
  await page.goto("/");
  await row(page).click();
  await expect(page.getByTestId("study-detail")).toBeVisible();
  await expect(page.getByTestId("state-inspected")).toHaveCount(0);
  await expect(page.getByTestId("state-bookmarked")).toBeVisible();

  // 戻す
  await asRole(page, "技師");
  await page.goto("/");
  await row(page).click();
  await page.getByTestId("state-inspected").click();
  await expect(page.getByTestId("state-inspected")).toHaveText("未検像");
});

test("ビューア：▶ と、ダブルクリックで既定のビューアを別のタブで開き、開いたことを記録する", async ({ page }) => {
  await asRole(page, "管理者");
  const before = await (await page.request.get("/api/audit/verify")).json();

  await expectOpened(
    page,
    () => row(page).getByTestId("open-default").click(),
    `https://viewer.example.org/ohif/viewer?StudyInstanceUIDs=${STUDY}`,
  );
  await expectOpened(page, () => row(page).locator("td").nth(3).dblclick(), /viewer\.example\.org\/ohif\/viewer/);

  const after = await (await page.request.get("/api/audit/verify")).json();
  expect(after.ok).toBe(true);
  expect(after.checked).toBeGreaterThan(before.checked);
});

test("ビューア：▾ から「この検査は次から Stone」と覚え、行に既定を出し、覚えを消せる", async ({ page }) => {
  await asRole(page, "医師");
  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: "この検査は次から Stone" }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveText("既定: Stone");

  await expectOpened(
    page,
    () => row(page).getByTestId("open-default").click(),
    `https://viewer.example.org/stone/index.html?study=${STUDY}`,
  );

  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: /覚えを消す/ }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveCount(0);

  // 閲覧には覚えさせる項目が無い
  await asRole(page, "閲覧");
  await page.goto("/");
  await row(page).getByTestId("open-menu").click();
  await expect(page.getByRole("menuitem", { name: /この検査は次から/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /DICOMweb の URL をコピー/ })).toContainText("このアプリの監査の外");
});

test("モダリティごとの既定のビューア：管理者が管理の画面で変え、ほかの役割は開けない", async ({ page }) => {
  await asRole(page, "医師");
  await page.goto("/admin/viewers");
  await expect(page.getByText("管理者だけが開ける")).toBeVisible();

  await asRole(page, "管理者");
  await page.getByRole("navigation", { name: "頁" }).getByRole("link", { name: "ビューアの既定" }).click();
  await expect(page).toHaveURL(/\/admin\/viewers$/);
  const ct = page.getByLabel("CT の既定のビューア");
  await expect(ct).toHaveValue("ohif");
  await ct.selectOption("stone");
  await expect(page.getByText("CT の既定を変えた")).toBeVisible();

  await page.goto("/");
  await expectOpened(page, () => row(page).getByTestId("open-default").click(), /viewer\.example\.org\/stone\//);

  // 戻す
  await page.goto("/admin/viewers");
  await page.getByLabel("CT の既定のビューア").selectOption("ohif");
  await expect(page.getByText("CT の既定を変えた")).toBeVisible();
});
