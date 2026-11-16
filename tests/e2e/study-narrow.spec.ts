import { expect, test, type Page } from "@playwright/test";

// 検査一覧の検索の改善（docs/spec.md の 3.1）：セルから同じ値で絞る・検索語の履歴・検査日の短縮入力。
// 検証モード（AUTH_MODE=dev）とモックのバックエンドに対して実行する。

async function asGeneral(page: Page) {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: "一般" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.getByTestId("study-count")).toHaveText("8");
}

test("患者 ID を押すと、その患者の検査だけが全期間で出る：行は選ばれず、検索の欄に患者 ID が入り、条件をクリアで戻る", async ({ page }) => {
  await asGeneral(page);
  // 先に、モダリティ（CT）・期間指定・性別（男）の絞り込みを入れておく（患者の検査を探す操作は、それを全部外す）
  await page.getByTestId("modality-CT").click();
  await page.getByTestId("filter-more").click();
  await page.getByTestId("filter-period").fill("2026");
  await page.getByTestId("filter-period").press("Enter");
  await page.getByTestId("filter-sex").selectOption("M");
  await expect(page).toHaveURL(/date=range/);
  await expect(page).toHaveURL(/sex=M/);
  await expect(page).toHaveURL(/modality=CT/);
  await expect(page.getByTestId("study-count")).toHaveText("4");

  const first = page.getByTestId("study-table").locator("tbody tr").first();
  const id = (await first.getByTestId("patient-id").innerText()).trim();
  await first.getByTestId("narrow-patient").click();
  // ほかの条件は全部外れ、その患者の検査が全期間・全モダリティで出る
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect(page).not.toHaveURL(/date=|sex=|modality=/);
  await expect(page.getByTestId("modality-all")).toHaveAttribute("aria-pressed", "true");

  // 行は選ばれない（行を選ぶ操作と取り違えない）
  await expect(page.locator('tr[aria-selected="true"]')).toHaveCount(0);
  await expect(page.getByTestId("study-search")).toHaveValue(id);
  await expect(page).toHaveURL(new RegExp(`[?&]q=${encodeURIComponent(id)}(&|$)`));
  await expect(page.getByTestId("date-all")).toHaveAttribute("aria-pressed", "true");
  const ids = await page.getByTestId("patient-id").allInnerTexts();
  expect(ids.length).toBeGreaterThan(0);
  expect(new Set(ids.map((s) => s.trim()))).toEqual(new Set([id]));

  // 検索語の履歴に残る
  await expect(page.getByTestId("study-search-history").locator("option")).toHaveCount(1);
  await expect(page.getByTestId("study-search-history").locator("option").first()).toHaveAttribute("value", id);

  await page.getByTestId("filter-clear").click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("study-search")).toHaveValue("");
});

test("値のボタンはキーボードで押せる：行から Tab で入り、Enter・Space で絞る。行の Enter（ビューアで開く）にならず、行は選ばれない", async ({ page }) => {
  await asGeneral(page);
  let popups = 0;
  page.on("popup", () => popups++);
  const rowOf = (n: number) => page.getByTestId("study-table").locator("tbody tr").nth(n);
  const first = rowOf(0);
  const id = (await first.getByTestId("patient-id").innerText()).trim();
  // 行にフォーカス → Tab（検査日のボタン）→ Tab（患者 ID のボタン）
  await first.focus();
  await page.keyboard.press("Tab");
  await expect(first.getByTestId("narrow-day")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(first.getByTestId("narrow-patient")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("study-search")).toHaveValue(id);
  await expect(page.locator('tr[aria-selected="true"]')).toHaveCount(0);
  await page.getByTestId("filter-clear").click();
  await expect(page.getByTestId("study-count")).toHaveText("8");

  // Space でも押せる（行の Space は選ぶ操作だが、ボタンの Space は行に届かない）
  await rowOf(1).getByTestId("narrow-patient").focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("study-search")).not.toHaveValue("");
  await expect(page.locator('tr[aria-selected="true"]')).toHaveCount(0);
  expect(popups).toBe(0);
});

test("検査日・モダリティを押しても、詳細条件の開閉と、ほかの欄の入力は残る（絞り込みの部品を作り直さない）", async ({ page }) => {
  await asGeneral(page);
  await page.getByTestId("filter-more").click();
  await page.getByTestId("filter-desc").fill("abc");
  await page.getByTestId("study-table").locator("tbody tr").first().getByTestId("narrow-modality").first().click();
  await expect(page.getByTestId("filter-more-panel")).toBeVisible();
  await expect(page.getByTestId("filter-desc")).toHaveValue("abc");
  await expect(page.locator('[data-testid^="modality-"][aria-pressed="true"]')).toHaveCount(1);
});

test("検査日を押すと、その 1 日の期間指定になる：詳細条件が開いて開始日と終了日に出る", async ({ page }) => {
  await asGeneral(page);
  const first = page.getByTestId("study-table").locator("tbody tr").first();
  const day = (await first.getByTestId("narrow-day").innerText()).trim();
  const iso = day.replaceAll("/", "-");
  await first.getByTestId("narrow-day").click();

  await expect(page).toHaveURL(new RegExp(`date=range&from=${iso}&to=${iso}`));
  await expect(page.locator('tr[aria-selected="true"]')).toHaveCount(0);
  await expect(page.getByTestId("filter-more-panel")).toBeVisible();
  await expect(page.getByLabel("開始日")).toHaveValue(iso);
  await expect(page.getByLabel("終了日")).toHaveValue(iso);
  const dates = await page.getByTestId("narrow-day").allInnerTexts();
  expect(dates.length).toBeGreaterThan(0);
  for (const d of dates) expect(d.trim()).toBe(day);
});

test("モダリティの印を押すと、その群だけを選ぶ", async ({ page }) => {
  await asGeneral(page);
  const first = page.getByTestId("study-table").locator("tbody tr").first();
  const mark = first.getByTestId("narrow-modality").first();
  const modality = (await mark.innerText()).trim();
  await mark.click();
  await expect(page.locator('tr[aria-selected="true"]')).toHaveCount(0);
  const pressed = page.locator('[data-testid^="modality-"][aria-pressed="true"]');
  await expect(pressed).toHaveCount(1);
  expect((await pressed.getAttribute("data-testid"))!.replace("modality-", "")).toContain(modality.slice(0, 2));
});

test("値でない所を押すと、これまでどおり行が選ばれる", async ({ page }) => {
  await asGeneral(page);
  const first = page.getByTestId("study-table").locator("tbody tr").first();
  await first.getByTestId("patient-name").click();
  await expect(first).toHaveAttribute("aria-selected", "true");
});

test("検索語の履歴：検索した語が新しい順に候補に出る（5 件まで・同じ語は 1 件）。ブラウザーの保存先には書かない", async ({ page }) => {
  await asGeneral(page);
  const search = page.getByTestId("study-search");
  for (const w of ["JP-TEST-0001", "JP-TEST-0002", "JP-TEST-0003", "JP-TEST-0004", "JP-TEST-0005", "JP-TEST-0006", "JP-TEST-0002"]) {
    await search.fill(w);
    await expect(page).toHaveURL(new RegExp(`q=${w}`));
  }
  const options = page.getByTestId("study-search-history").locator("option");
  await expect(options).toHaveCount(5);
  expect(await options.evaluateAll((os) => os.map((o) => o.getAttribute("value")))).toEqual([
    "JP-TEST-0002",
    "JP-TEST-0006",
    "JP-TEST-0005",
    "JP-TEST-0004",
    "JP-TEST-0003",
  ]);
  await expect(search).toHaveAttribute("list", (await page.getByTestId("study-search-history").getAttribute("id"))!);
  expect(await page.evaluate(() => `${localStorage.length}/${sessionStorage.length}`)).toBe("0/0");
  // 頁を読み込み直す（ログアウトも、頁ごと読み込み直す）と、履歴は消える
  await page.reload();
  await expect(page.getByTestId("study-search")).toHaveValue("JP-TEST-0002");
  await expect(page.getByTestId("study-search-history").locator("option")).toHaveCount(0);
});

test("検査日の短縮入力：202604 は 4 月の期間、読めない入力は誤りを出して条件にしない", async ({ page }) => {
  await asGeneral(page);
  await page.getByTestId("filter-more").click();
  const period = page.getByTestId("filter-period");

  await period.fill("202604");
  await expect(page.getByTestId("filter-period-hint")).toHaveText("2026/04/01 〜 2026/04/30");
  await period.press("Enter");
  await expect(page).toHaveURL(/date=range&from=2026-04-01&to=2026-04-30/);
  await expect(page.getByLabel("開始日")).toHaveValue("2026-04-01");
  await expect(page.getByLabel("終了日")).toHaveValue("2026-04-30");
  await expect(period).toHaveValue("");

  // 開いた期間（A-）は、終わりが無い
  await period.fill("202606-");
  await period.press("Enter");
  await expect(page).toHaveURL(/date=range&from=2026-06-01(&|$)/);
  await expect(page.getByLabel("終了日")).toHaveValue("");

  // 読めない入力は、条件にしない
  const before = page.url();
  await period.fill("202613");
  await expect(page.getByTestId("filter-period-msg")).toContainText("検査日を読み取れません");
  await expect(period).toHaveAttribute("aria-invalid", "true");
  await period.press("Enter");
  expect(page.url()).toBe(before);
  await expect(period).toHaveValue("202613");
});
