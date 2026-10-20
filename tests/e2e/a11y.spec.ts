import { expect, test, type Page } from "@playwright/test";

// アクセシビリティと狭い画面の直し（2026-10-20 の UX のレビューの M2・M3・M4・M8）。検証モード（AUTH_MODE=dev）とモックに対して流す。
// - M2：一覧の行の中の「開く」「▾」は Tab の止まり先にしない。行で Shift+F10 を押すとビューアのメニューが開く。
// - M3：ビューアのメニューは詳細のパネルの枠に切られず、開くと最初の項目へフォーカスが入り、矢印・Home・End・Escape を受ける。
// - M4：部品の枠の線は、地と 3:1 以上の色（明るい地は #818b98）。
// - M8：390px の幅で、ナビゲーションの項目を折り返さず、頁が横にはみ出さない。

test.describe.configure({ mode: "serial" });

async function asAdmin(page: Page) {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: "管理者" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

const rows = (page: Page) => page.getByTestId("study-table").locator("tbody > tr[data-study-uid]");
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { testId: el?.dataset.testid ?? null, role: el?.getAttribute("role") ?? null, text: el?.textContent?.trim() ?? "", row: el?.tagName === "TR", inTable: !!el?.closest("[data-testid=study-table]") };
  });

test("一覧の行：Tab は行の中のボタンに止まらず、Shift+F10 でビューアのメニューが開く（M2）", async ({ page }) => {
  await asAdmin(page);
  await expect(rows(page)).toHaveCount(8);
  const first = rows(page).first();
  await first.focus();
  // 前は、行の次の Tab が同じ行の「開く」に止まり、次の Tab が「▾」に止まった（行ごとに 2 回）
  await page.keyboard.press("Tab");
  const after = await focused(page);
  expect(after.inTable).toBe(false);
  expect(["open-default", "open-menu"]).not.toContain(after.testId);
  for (const id of ["open-default", "open-menu"]) await expect(first.getByTestId(id)).toHaveAttribute("tabindex", "-1");

  // 行で Shift+F10：メニューが開き、最初の項目にフォーカスが入る。Escape で閉じ、行へ戻る
  await first.focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: "ビューアを選択" });
  await expect(menu).toBeVisible();
  const items = menu.getByRole("menuitem");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(first).toBeFocused();
  // 選んだ行は aria-current でも伝える（表は grid ではないので、aria-selected は読み上げに伝わらない）
  await first.click();
  await expect(first).toHaveAttribute("aria-current", "true");
  await expect(rows(page).nth(1)).not.toHaveAttribute("aria-current", /.*/);
});

test("ビューアのメニュー：詳細のパネルの枠に切られず、矢印・Home・End で項目を移る（M3）", async ({ page }) => {
  // 詳細のパネルが低い画面（前は最後の項目がパネルのスクロールの枠に切られた）
  await page.setViewportSize({ width: 1280, height: 600 });
  await asAdmin(page);
  await rows(page).first().click();
  const detail = page.getByTestId("study-detail");
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  await detail.getByTestId("open-menu").click();
  const menu = page.getByRole("menu", { name: "ビューアを選択" });
  await expect(menu).toBeVisible();
  // メニューは body の直下（パネルの枠の外）に出し、全部の項目が画面の中に見える
  expect(await menu.evaluate((el) => el.parentElement === document.body)).toBe(true);
  const items = menu.getByRole("menuitem");
  const n = await items.count();
  expect(n).toBeGreaterThan(2);
  for (let i = 0; i < n; i++) await expect(items.nth(i)).toBeInViewport({ ratio: 1 });

  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(items.nth(1)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(items.nth(n - 1)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(items.first()).toBeFocused();
  await page.keyboard.press("End");
  await expect(items.nth(n - 1)).toBeFocused();
  // Escape はメニューだけを閉じ（詳細のパネルは開いたまま）、▾ へフォーカスを戻す
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("open-menu")).toBeFocused();
  // 外を押しても閉じる
  await detail.getByTestId("open-menu").click();
  await expect(menu).toBeVisible();
  await page.getByTestId("detail-head").click();
  await expect(menu).toHaveCount(0);
});

test("部品の枠の線：入力欄・枠のボタン・絞り込みの枠は、地と 3:1 以上の色（M4）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await asAdmin(page);
  const color = (testId: string) => page.getByTestId(testId).evaluate((el) => getComputedStyle(el).borderTopColor);
  // #818b98（明るい地）。表の罫線は飾りの線なので前の色のまま
  expect(await color("study-search")).toBe("rgb(129, 139, 152)");
  expect(await color("filter-more")).toBe("rgb(129, 139, 152)");
  expect(await page.getByRole("group", { name: "検査日" }).first().evaluate((el) => getComputedStyle(el).borderTopColor)).toBe(
    "rgb(129, 139, 152)",
  );
  expect(await color("study-list-scroll")).toBe("rgb(209, 217, 224)");
});

test("狭い画面（390px）：ナビゲーションの項目を折り返さず、頁は横にはみ出さない（M8）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await asAdmin(page);
  const nav = page.getByRole("navigation", { name: "頁" });
  const links = nav.getByRole("link");
  expect(await links.count()).toBeGreaterThanOrEqual(4);
  // 1 行の高さ（前は「検/査」のように 1 字ずつ折り返し、3 段になった）
  const heights = await links.evaluateAll((els) => els.map((el) => (el as HTMLElement).offsetHeight));
  for (const h of heights) expect(h).toBeLessThan(45);
  const tops = await links.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(new Set(tops).size).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // 検査日・モダリティの並びは画面の幅に収め、入りきらない端の項目は、並びの中を横に送って押せる
  for (const name of ["検査日", "モダリティ"]) {
    const box = (await page.getByRole("group", { name }).first().boundingBox())!;
    expect(box.x + box.width, name).toBeLessThanOrEqual(390);
  }
  await page.getByTestId("modality-SR").click();
  await expect(page.getByTestId("modality-SR")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("date-all").click();
  await expect(page.getByTestId("date-all")).toHaveAttribute("aria-pressed", "true");
  // 入りきらない項目は、ナビゲーションの中を横に送って押せる
  const last = links.last();
  const href = await last.getAttribute("href");
  await last.click();
  await expect(page).toHaveURL(new RegExp(`${href}$`));
});
