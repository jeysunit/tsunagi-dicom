import { expect, test, type Locator, type Page } from "@playwright/test";

// 詳細の操作の行と、一覧の行の「開く」（docs/design-system/components.md の「ボタン」）：
// 主（藍）は詳細の操作の行の「開く」に 1 つだけ。一覧の行の「開く」は副（白地・枠）。
// 検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

async function asRole(page: Page, label: "管理者" | "一般") {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

const background = (el: Locator) => el.evaluate((node) => getComputedStyle(node).backgroundColor);

test("一覧の行の「開く」は副（白地・枠）、詳細の操作の行の「開く」だけが主（藍）", async ({ page }) => {
  await asRole(page, "一般");
  const white = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const rowOpen = page.locator(`tr[data-study-uid="${STUDY}"]`).getByTestId("open-default");
  expect(await background(rowOpen)).toBe(white);
  expect(await rowOpen.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");

  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  const detail = page.getByTestId("study-detail");
  const primary = detail.getByTestId("open-default");
  await expect(primary).toBeVisible();
  expect(await background(primary)).not.toBe(white);

  // 画面にある「開く」のうち、白地でないもの（主）は、詳細の 1 つだけ
  const all = page.getByTestId("open-default");
  const colors = await all.evaluateAll((els) => els.map((el) => getComputedStyle(el).backgroundColor));
  expect(colors.filter((c) => c !== white)).toHaveLength(1);
});

test("詳細の「開く ▾」は操作の行の先頭にあり、押すと、左そろえでメニューが開く（画面の左に切れない）", async ({ page }) => {
  await asRole(page, "一般");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  const detail = page.getByTestId("study-detail");
  const group = detail.getByRole("group", { name: "検査の操作" });
  await expect(group.getByTestId("open-default")).toBeVisible();
  const open = detail.getByTestId("open-menu");
  await open.click();
  const menu = detail.getByRole("menu");
  await expect(menu).toBeVisible();
  const box = (await menu.boundingBox())!;
  const anchor = (await group.getByTestId("open-default").boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  // メニューの左端は、「開く」の左端にそろう
  expect(Math.abs(box.x - anchor.x)).toBeLessThanOrEqual(2);
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
});

test("詳細の操作の行は Study UID の行より下にあり、見出しの右にはビューアの部品が無い", async ({ page }) => {
  await asRole(page, "一般");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  const detail = page.getByTestId("study-detail");
  const open = (await detail.getByRole("group", { name: "検査の操作" }).getByTestId("open-default").boundingBox())!;
  const uid = (await detail.getByTestId("study-uid").boundingBox())!;
  expect(open.y).toBeGreaterThan(uid.y + uid.height - 2);
  await expect(detail.getByTestId("detail-head").getByTestId("open-default")).toHaveCount(0);
});
// 管理者の操作の行（送信・エクスポート・削除の並び）は、書き込みの有効な local-auth.spec.ts で確かめる
