import { expect, test, type Page } from "@playwright/test";

// 検査の一覧の列見出しでの並べ替え（docs/spec.md の 3.1）。検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。

async function asGeneral(page: Page) {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: "一般" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.getByTestId("study-count")).toHaveText("8");
}

const ids = (page: Page) => page.getByTestId("study-table").locator("tbody td[data-testid=patient-id]").allInnerTexts();
const header = (page: Page, key: string) => page.getByTestId("study-table").locator(`th:has([data-testid=sort-${key}])`);

test("列見出しは並べ替えのボタン：最初は検査日時の降順（aria-sort）。押した列が昇順になり、もう一度で降順になる", async ({ page }) => {
  await asGeneral(page);
  await expect(header(page, "date")).toHaveAttribute("aria-sort", "descending");
  await expect(header(page, "id")).not.toHaveAttribute("aria-sort");
  const initial = await ids(page);

  await page.getByTestId("sort-id").click();
  await expect(header(page, "id")).toHaveAttribute("aria-sort", "ascending");
  await expect(header(page, "date")).not.toHaveAttribute("aria-sort");
  const collator = new Intl.Collator("ja", { numeric: true });
  const asc = await ids(page);
  expect(asc).toEqual([...asc].sort(collator.compare));
  expect([...asc].sort()).toEqual([...initial].sort());

  await page.getByTestId("sort-id").click();
  await expect(header(page, "id")).toHaveAttribute("aria-sort", "descending");
  expect(await ids(page)).toEqual([...asc].reverse());

  // 検査日時を押すと昇順（最初の降順の逆）。もう一度で降順に戻り、最初の並びと同じになる
  await page.getByTestId("sort-date").click();
  await expect(header(page, "date")).toHaveAttribute("aria-sort", "ascending");
  await page.getByTestId("sort-date").click();
  await expect(header(page, "date")).toHaveAttribute("aria-sort", "descending");
  expect(await ids(page)).toEqual(initial);
});

test("並べ替えても、件数・選んだ行・詳細は変わらない。絞り込みを替えても並びを保つ", async ({ page }) => {
  await asGeneral(page);
  await page.getByTestId("sort-id").click();
  await expect(page.getByTestId("study-count")).toHaveText("8");

  const first = page.getByTestId("study-table").locator("tbody > tr[data-study-uid]").first();
  const uid = await first.getAttribute("data-study-uid");
  await first.click();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("sort-id").click();
  await expect(page.locator(`tr[data-study-uid="${uid}"]`)).toHaveAttribute("aria-selected", "true");

  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect(header(page, "id")).toHaveAttribute("aria-sort", "descending");
});

test("上限に届いたとき（件数が「以上」）は、並べ替えが読んだ範囲の中だけと分かる注記を出す。最初の並びでは出さない", async ({ page }) => {
  await asGeneral(page);
  // 画像サーバーの答えが上限に届いた形にする（件数が「以上」）。絞り込みを替えて読み直させる
  await page.route("**/api/studies?*", async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.count.exact = false;
    await route.fulfill({ response: res, json: body });
  });
  const note = page.getByTestId("sort-limit-note");
  const reload = page.waitForResponse((r) => r.url().includes("/api/studies?") && r.url().includes("modality=CT"));
  await page.getByTestId("modality-CT").click();
  await reload;
  await expect(page.getByTestId("study-count")).toContainText("以上");
  await expect(note).toHaveCount(0);

  await page.getByTestId("sort-id").click();
  await expect(note).toHaveText("先頭の1000件の中で並べ替えています");

  // 最初の並び（検査日時の降順）に戻すと、注記は消える
  await page.getByTestId("sort-date").click();
  await page.getByTestId("sort-date").click();
  await expect(note).toHaveCount(0);
});
