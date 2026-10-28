import { expect, test, type Locator, type Page } from "@playwright/test";

// 一覧の表の操作の列（docs/design-system/components.md の「一覧の表」の「幅が足りないとき」）。
// 表が一覧の幅に収まらず横にスクロールしても、行のボタン・リンクは表の右端に固定され、見切れない。
// 2026-10-27 に、検査一覧の「開く」が 1280〜1440px ほどの画面で表の外に切れていた（横にスクロールしないと見えない）。

const WIDTHS = [390, 1280, 1440, 1920, 2000] as const;
const RECEIVED_SAMPLE_DAY = "/received?period=range&from=2026-10-17&to=2026-10-17";

async function asRole(page: Page, label: "管理者" | "一般") {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

/** 部品が、スクロールする包み（表の外側）の見えている幅の中に、左右とも収まっているか */
async function expectInsideBox(control: Locator, box: Locator) {
  await expect(control).toBeVisible();
  const c = await control.boundingBox();
  const b = await box.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left + el.clientLeft, right: r.left + el.clientLeft + el.clientWidth };
  });
  expect(c, "部品の位置が取れない").not.toBeNull();
  expect(c!.x).toBeGreaterThanOrEqual(b.left - 0.5);
  expect(c!.x + c!.width).toBeLessThanOrEqual(b.right + 0.5);
}

for (const width of WIDTHS) {
  test(`検査一覧：${width}px の画面でも、行の「開く」とビューアの選択は一覧の中に見える`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await asRole(page, "一般");
    const box = page.getByTestId("study-list-scroll");
    const row = page.locator("tbody tr[data-study-uid]").first();
    await expect(row).toBeVisible();
    await expectInsideBox(row.getByTestId("open-default"), box);
    await expectInsideBox(row.getByTestId("open-menu"), box);
    // 横にスクロールする幅では、文字の列は動き、操作の列は右端に残る
    const scrolls = await box.evaluate((el) => el.scrollWidth > el.clientWidth);
    if (scrolls) {
      await box.evaluate((el) => {
        el.scrollLeft = 0;
      });
      await expectInsideBox(row.getByTestId("open-default"), box);
      await box.evaluate((el) => {
        el.scrollLeft = el.scrollWidth;
      });
      await expectInsideBox(row.getByTestId("open-default"), box);
    }
  });

  test(`受信一覧・接続先：${width}px の画面でも、行のボタンとリンクは表の中に見える`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await asRole(page, "一般");
    await page.goto(RECEIVED_SAMPLE_DAY);
    const received = page.getByTestId("received-row").first();
    await expect(received).toBeVisible();
    await expectInsideBox(received.getByTestId("received-open"), page.getByTestId("received-scroll"));

    await page.goto("/modalities");
    const modality = page.getByTestId("modality-row").first();
    await expect(modality).toBeVisible();
    const box = page.getByTestId("modality-table").locator("xpath=..");
    await expectInsideBox(modality.getByTestId("echo"), box);
  });
}

test("固定した操作の列で開いたビューアのメニューは、下の行の固定のセルに隠れない", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await asRole(page, "一般");
  const row = page.locator("tbody tr[data-study-uid]").first();
  await row.getByTestId("open-menu").click();
  const menu = row.getByRole("menu");
  await expect(menu).toBeVisible();
  // メニューの項目の真ん中で、いちばん上に描かれているのがメニューの中の物か
  for (const item of await menu.getByRole("menuitem").all()) {
    const topmostInMenu = await item.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && !!hit.closest("[role=menu]");
    });
    expect(topmostInMenu).toBe(true);
  }
});

test("固定した操作の列は地を塗り、選んだ行では行と同じ地になる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await asRole(page, "一般");
  // 検査一覧は、行を選ぶと詳細が開いて操作の列を省く（詰めた形）ので、選ぶ前の地だけを見る
  const study = page.locator("tbody tr[data-study-uid]").first().getByTestId("study-actions");
  await expect(study).toHaveCSS("position", "sticky");
  expect(await study.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");

  await page.goto(RECEIVED_SAMPLE_DAY);
  const row = page.getByTestId("received-row").first();
  const cell = row.getByTestId("received-actions");
  await expect(cell).toHaveCSS("position", "sticky");
  await row.getByTestId("received-at").click();
  await expect(row).toHaveAttribute("aria-selected", "true");
  const [rowBg, cellBg] = await Promise.all([
    row.evaluate((el) => getComputedStyle(el).backgroundColor),
    cell.evaluate((el) => getComputedStyle(el).backgroundColor),
  ]);
  expect(cellBg).toBe(rowBg);
});
