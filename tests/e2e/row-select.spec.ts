import { expect, test, type Locator, type Page } from "@playwright/test";

// 表の行を選ぶ（docs/design-system/components.md の「一覧の表」「タグの表」）：
// - 受信一覧・検査一覧：クリックした行・矢印のキーで動かした行は、selected の地と左の線に替わる。読み上げには aria-selected
// - 検査の詳細の DICOM タグの表：クリック・Shift・Ctrl／Cmd で複数選び、右クリックのメニューかキーボードで「タグとタグ値をコピー」
// - UID の写すボタンは UID のすぐ右
// 検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

async function asRole(page: Page, label: "管理者" | "一般") {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

const background = (row: Locator) => row.evaluate((el) => getComputedStyle(el).backgroundColor);
/** 色のほかに示すもの：左の 3px の線（先頭のセルの内側の影）と、太字 */
const hasMarkLine = (row: Locator) =>
  row.locator("td").first().evaluate((el) => {
    const style = getComputedStyle(el);
    return style.boxShadow !== "none" && /\b3px\b/.test(style.boxShadow) && Number(style.fontWeight) >= 700;
  });

test("受信一覧：クリックした行は地と左の線が替わり、aria-selected になる。別の行を押すと移る", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto("/received");
  const rows = page.getByTestId("received-row");
  const [a, b] = [rows.nth(2), rows.nth(4)];
  const before = await background(a);
  await expect(a).toHaveAttribute("aria-selected", "false");
  expect(await hasMarkLine(a)).toBe(false);

  await a.getByTestId("received-at").click();
  await expect(a).toHaveAttribute("aria-selected", "true");
  expect(await background(a)).not.toBe(before);
  expect(await hasMarkLine(a)).toBe(true);

  await b.getByTestId("received-at").click();
  await expect(b).toHaveAttribute("aria-selected", "true");
  await expect(a).toHaveAttribute("aria-selected", "false");
  expect(await hasMarkLine(a)).toBe(false);
  await expect(page.locator('[data-testid=received-row][aria-selected="true"]')).toHaveCount(1);
});

test("受信一覧：矢印のキーで動かした行が選ばれ、止まり先の行は 1 つだけ。Esc で外れる", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto("/received");
  const rows = page.getByTestId("received-row");
  await rows.first().focus();
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(2)).toHaveAttribute("aria-selected", "true");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowUp");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid=received-row][tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid=received-row][aria-selected="true"]')).toHaveCount(0);
});

test("受信一覧：行の中の「検査一覧で表示」は、行を選ぶ操作にしない", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto("/received");
  const target = page.getByTestId("received-row").nth(1);
  await target.getByRole("link", { name: "検査一覧で表示" }).click();
  await expect(page).toHaveURL(/q=/);
});

test("検査一覧：クリックした行は地と左の線が替わる。矢印のキーで動かした行に移る", async ({ page }) => {
  await asRole(page, "一般");
  const rows = page.getByTestId("study-table").locator("tbody > tr[data-study-uid]");
  const first = rows.first();
  const before = await background(first);
  await first.click();
  await expect(first).toHaveAttribute("aria-selected", "true");
  expect(await background(first)).not.toBe(before);
  expect(await hasMarkLine(first)).toBe(true);
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(first).toHaveAttribute("aria-selected", "false");
  expect(await hasMarkLine(rows.nth(1))).toBe(true);
});

/** 検査の詳細を開き、サムネイルから画像の場所を開いて、主なタグの表を返す */
async function openTagTable(page: Page): Promise<Locator> {
  await asRole(page, "一般");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  const strip = page.getByTestId("series-strip");
  await expect(strip).toHaveAttribute("data-loaded", "true");
  await strip.getByTestId("series-open").click();
  const table = page.getByTestId("series-images").getByTestId("instance-tags");
  await expect(table.locator("tbody tr")).toHaveCount(25);
  return table;
}

const selectedTags = (table: Locator) => table.locator('tbody tr[aria-selected="true"]');
const clipboard = (page: Page) => page.evaluate(() => navigator.clipboard.readText());

test("タグの表：クリックで行を選び、Shift で範囲、Ctrl で足す・外す。選んだ行は地と左の線が替わる", async ({ page }) => {
  const table = await openTagTable(page);
  const tr = (i: number) => table.locator("tbody tr").nth(i);
  const before = await background(tr(2));
  await tr(2).click();
  await expect(selectedTags(table)).toHaveCount(1);
  expect(await background(tr(2))).not.toBe(before);
  expect(await hasMarkLine(tr(2))).toBe(true);
  await expect(table.getByRole("grid")).toHaveAttribute("aria-multiselectable", "true");

  await tr(5).click({ modifiers: ["Shift"] });
  await expect(selectedTags(table)).toHaveCount(4);
  await tr(8).click({ modifiers: ["ControlOrMeta"] });
  await expect(selectedTags(table)).toHaveCount(5);
  await tr(3).click({ modifiers: ["ControlOrMeta"] });
  await expect(selectedTags(table)).toHaveCount(4);
  await expect(tr(3)).toHaveAttribute("aria-selected", "false");
  expect(await hasMarkLine(tr(3))).toBe(false);

  // ふつうのクリックは、ほかの選びを外す
  await tr(0).click();
  await expect(selectedTags(table)).toHaveCount(1);
});

test("タグの表：矢印のキー（Shift で範囲）・Space・Ctrl+A・Esc で選べる。止まり先の行は 1 つ", async ({ page }) => {
  const table = await openTagTable(page);
  const tr = (i: number) => table.locator("tbody tr").nth(i);
  await tr(0).focus();
  await page.keyboard.press("ArrowDown");
  await expect(tr(1)).toBeFocused();
  await expect(selectedTags(table)).toHaveCount(1);
  await expect(tr(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await expect(selectedTags(table)).toHaveCount(3);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(tr(4)).toHaveAttribute("aria-selected", "false");
  await expect(table.locator('tbody tr[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+a");
  await expect(selectedTags(table)).toHaveCount(25);
  await page.keyboard.press("Escape");
  await expect(selectedTags(table)).toHaveCount(0);
});

test("タグの表：右クリックのメニューで、選んだ行を「(タグ) タグ名 VR 値」のタブ区切りで写す", async ({ page }) => {
  const table = await openTagTable(page);
  const tr = (tag: string) => table.locator(`tr[data-tag="${tag}"]`);
  // 選んでいない行の上で右クリックすると、その行だけが選ばれる
  await tr("0008,0018").click({ button: "right" });
  const menu = page.getByTestId("tag-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText("タグとタグ値をコピー");
  await expect(menu.getByRole("menuitem")).toBeFocused();
  await expect(selectedTags(table)).toHaveCount(1);
  await menu.getByRole("menuitem").click();
  await expect(menu).toHaveCount(0);
  const sop = (await table.locator('tr[data-tag="0008,0018"] [data-testid=tag-value]').textContent())!;
  expect(await clipboard(page)).toBe(`(0008,0018)\tSOPインスタンスUID\tUI\t${sop}`);
  await expect(page.getByTestId("tag-copy-notice")).toHaveText("1 行をコピーしました");

  // 複数を選んだ行の上で右クリックすると、選びを保ったまま全部を写す（改行でつなぐ）
  await tr("0020,0013").click();
  await tr("0028,0010").click({ modifiers: ["ControlOrMeta"] });
  await tr("0028,0010").click({ button: "right" });
  await page.getByTestId("tag-copy").click();
  const lines = (await clipboard(page)).split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\(0020,0013\)\t画像番号\tIS\t\d+$/);
  expect(lines[1]).toMatch(/^\(0028,0010\)\t行数\tUS\t\d+$/);
  // 値が無いタグは、値の欄が空
  await tr("0018,0050").click();
  await tr("0018,0050").click({ button: "right" });
  await page.getByTestId("tag-copy").click();
  expect(await clipboard(page)).toMatch(/^\(0018,0050\)\tスライス厚\t[A-Z]*\t$/);
});

test("タグの表：キーボードの Ctrl+C と、メニューのキーでも写せる。Esc でメニューを閉じるとフォーカスが行に戻る", async ({ page }) => {
  const table = await openTagTable(page);
  const tr = (i: number) => table.locator("tbody tr").nth(i);
  await tr(1).click();
  await tr(2).click({ modifiers: ["Shift"] });
  await page.keyboard.press("ControlOrMeta+c");
  const text = await clipboard(page);
  expect(text.split("\n")).toHaveLength(2);
  expect(text.split("\n").every((l) => l.split("\t").length === 4)).toBe(true);
  await expect(page.getByTestId("tag-copy-notice")).toHaveText("2 行をコピーしました");

  await page.keyboard.press("ContextMenu");
  const menu = page.getByTestId("tag-menu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(tr(2)).toBeFocused();
  // 選びは Esc（メニューを閉じる）では外れない
  await expect(selectedTags(table)).toHaveCount(2);
});

test("タグの表：Shift でクリックした行にフォーカスが移り、続く矢印のキーはその行から動く", async ({ page }) => {
  const table = await openTagTable(page);
  const tr = (i: number) => table.locator("tbody tr").nth(i);
  await tr(1).click();
  await tr(5).click({ modifiers: ["Shift"] });
  await expect(tr(5)).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(tr(6)).toBeFocused();
  await expect(tr(6)).toHaveAttribute("aria-selected", "true");
  await expect(selectedTags(table)).toHaveCount(1);
});

test("タグの表：メニューを開いたまま外の欄を押したときは、フォーカスを表へ奪い返さない", async ({ page }) => {
  const table = await openTagTable(page);
  await table.locator("tbody tr").nth(1).click({ button: "right" });
  await expect(page.getByTestId("tag-menu")).toBeVisible();
  const search = page.getByRole("searchbox").first();
  await search.click();
  await expect(page.getByTestId("tag-menu")).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("受信一覧：選んだ行は、絞り込みで並びが変わっても同じ行のまま", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto("/received");
  const rows = page.getByTestId("received-row");
  const target = rows.nth(3);
  const patientId = (await target.locator("td").nth(3).textContent())!.trim();
  await target.getByTestId("received-at").click();
  const at = (await target.getByTestId("received-at").textContent())!;
  await page.getByTestId("received-search").fill(patientId);
  const picked = page.locator('[data-testid=received-row][aria-selected="true"]');
  await expect(picked).toHaveCount(1);
  await expect(picked.getByTestId("received-at")).toHaveText(at);
});

test("UID の写すボタンは、UID のすぐ右にある（行の右端に離れない）", async ({ page }) => {
  await asRole(page, "一般");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  const line = page.getByTestId("study-uid");
  await expect(line).toContainText("StudyInstanceUID");
  const code = (await line.locator("code").boundingBox())!;
  const button = (await line.getByRole("button", { name: "StudyInstanceUIDをコピー" }).boundingBox())!;
  const lineBox = (await line.boundingBox())!;
  // ボタンは UID の最後の文字の右 24px 以内。行の幅が広くても、右端へ離さない
  expect(button.x - (code.x + code.width)).toBeLessThanOrEqual(24);
  expect(button.x + button.width).toBeLessThan(lineBox.x + lineBox.width - 4);
  await line.getByRole("button", { name: "StudyInstanceUIDをコピー" }).click();
  expect(await clipboard(page)).toBe(STUDY);
});
