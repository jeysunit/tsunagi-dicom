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

  // もう一度押しても閉じない（下の詳細は選んだ行のものを出し続ける）。Escape で選びを外すと案内に戻る
  // （期待の変更：行の下に開く形をやめ、もう一度押して閉じる動きを、Escape に替えた。docs/spec.md の 3.1）
  await row(page).click();
  await expect(detail).toBeVisible();
  await row(page).focus();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId("study-detail-empty")).toBeVisible();
});

const detailUid = (page: Page) => page.getByTestId("study-detail").getByTestId("uid-line").first().locator("code");

test("上下に分ける：行を選ぶと下の詳細が替わり、一覧の行は動かない。頁全体はスクロールしない", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await asRole(page, "医師");
  await expect(rows(page)).toHaveCount(8);
  // 何も選んでいないときは、下に短い案内だけ
  await expect(page.getByTestId("study-detail-empty")).toBeVisible();
  await expect(page.getByTestId("study-detail")).toHaveCount(0);

  const noPageScroll = () =>
    page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight);
  expect(await noPageScroll()).toBe(true);

  const second = rows(page).nth(1);
  const secondUid = (await second.getAttribute("data-study-uid"))!;
  const before = await rows(page).nth(1).boundingBox();
  await rows(page).first().click();
  await expect(detailUid(page)).toHaveText((await rows(page).first().getAttribute("data-study-uid"))!);
  await second.click();
  await expect(detailUid(page)).toHaveText(secondUid);
  // 行の位置は動かない（詳細は行の下に開かない。一覧は選んだだけではスクロールしない）
  const after = await rows(page).nth(1).boundingBox();
  expect(after).toEqual(before);
  expect(await page.getByTestId("study-list-scroll").evaluate((el) => el.scrollTop)).toBe(0);
  // 詳細が長くても頁は伸びない。一覧の中だけがスクロールする
  expect(await noPageScroll()).toBe(true);
  const list = page.getByTestId("study-list-scroll");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // スクロールバーの出入りで画面が左右に寄らない
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toContain("stable");
});

test("上下に分ける：矢印の上下で行を移すと詳細が付いて替わり、Enter でビューアを開く。通り過ぎた行の詳細は読まない", async ({ page }) => {
  await asRole(page, "医師");
  const detailRequests: string[] = [];
  page.on("request", (req) => {
    const m = /\/api\/studies\/([0-9.]+)$/.exec(new URL(req.url()).pathname);
    if (m) detailRequests.push(m[1]!);
  });
  const uids = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-study-uid") ?? ""));

  await rows(page).first().click();
  await expect(detailUid(page)).toHaveText(uids[0]!);
  await expect.poll(() => detailRequests.length).toBe(1);

  // 続けて3回：選びは行に付いて動くが、詳細を読むのは止まった行（4 番目）だけ
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(3)).toBeFocused();
  await expect(detailUid(page)).toHaveText(uids[3]!);
  await expect(page.getByTestId("series-item").first()).toBeVisible();
  expect(detailRequests).toEqual([uids[0], uids[3]]);

  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(detailUid(page)).toHaveText(uids[2]!);

  // 一覧の端から外へは出ない
  await rows(page).first().focus();
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).first()).toBeFocused();

  // Enter で既定のビューア（別のタブ）
  await rows(page).first().focus();
  await expectOpened(page, () => page.keyboard.press("Enter"), /viewer\.example\.org\/(ohif|stone)\//);
});

test("上下に分ける：矢印で移した行は、一覧の見える所にスクロールする", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await asRole(page, "医師");
  await rows(page).first().click();
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
  const last = rows(page).last();
  await expect(last).toHaveAttribute("aria-selected", "true");
  const inView = await last.evaluate((el) => {
    const box = el.closest("[data-testid=study-list-scroll]")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.bottom + 1;
  });
  expect(inView).toBe(true);
});

test("上下に分ける：境目をキーボードで動かせ、位置を覚える", async ({ page }) => {
  await asRole(page, "医師");
  const handle = page.getByTestId("split-handle");
  await expect(handle).toHaveAttribute("role", "separator");
  await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  await expect(handle).toHaveAttribute("aria-valuenow", "60");
  const topHeight = () => page.locator("[data-split-root] > div").first().evaluate((el) => el.getBoundingClientRect().height);
  const h0 = await topHeight();

  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-valuenow", "65");
  expect(await topHeight()).toBeGreaterThan(h0);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "55");
  expect(await topHeight()).toBeLessThan(h0);
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "80");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-valuenow", "25");

  // 開き直しても同じ位置
  await page.reload();
  await expect(page.getByTestId("split-handle")).toHaveAttribute("aria-valuenow", "25");

  // ドラッグでも動く
  const box = (await page.getByTestId("split-handle").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 5 });
  await page.mouse.up();
  expect(Number(await page.getByTestId("split-handle").getAttribute("aria-valuenow"))).toBeGreaterThan(25);
});

test("上下に分ける：狭い画面では一覧だけを出し、行を選ぶと詳細を一覧の上に重ねる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await asRole(page, "医師");
  await expect(page.getByTestId("split-handle")).toBeHidden();
  await expect(page.getByTestId("detail-pane")).toBeHidden();
  const noPageScroll = () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
  expect(await noPageScroll()).toBe(true);

  // 表は幅が広く、行の中央は画面の外なので、見えている左の端を押す
  await row(page).click({ position: { x: 100, y: 20 } });
  await expect(page.getByTestId("study-detail")).toBeVisible();
  await expect(detailUid(page)).toHaveText(STUDY);
  expect(await noPageScroll()).toBe(true);
  await page.getByRole("button", { name: "詳細を閉じる" }).click();
  await expect(page.getByTestId("detail-pane")).toBeHidden();
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
