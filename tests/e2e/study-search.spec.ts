import { expect, test, type Page } from "@playwright/test";

// 横断の検索の当て方（docs/spec.md の 3.1）：患者 ID・受付番号は全体の一致、氏名と検査名は含む。
// 検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。

async function asGeneral(page: Page) {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: "一般" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.getByTestId("study-count")).toHaveText("8");
}

test("患者 ID は全体が一致するものだけ：一部（途中の字）では見つからず、全体なら見つかる", async ({ page }) => {
  await asGeneral(page);
  const search = page.getByTestId("study-search");

  // 全体の一致（旧：一部でも合った。期待を替えた）
  await search.fill("JP-TEST-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");

  // 一部（途中の字・前の字・後ろの字）は合わない
  for (const part of ["TEST-0004", "JP-TEST-000", "0004"]) {
    await search.fill(part);
    await expect(page.getByTestId("study-count")).toHaveText("0");
    await expect(page.getByText("該当する検査はありません")).toBeVisible();
  }

  // 全角・小文字でも、全体が一致すれば見つかる
  await search.fill("ｊｐ-test-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");
});

test("氏名は含むかで探す：姓の一部でも見つかる（患者 ID と当て方が違う）", async ({ page }) => {
  await asGeneral(page);
  await page.getByTestId("study-search").fill("やま");
  await expect(page.getByTestId("study-count")).not.toHaveText("0");
  await expect(page.getByTestId("study-count")).not.toHaveText("8");
});
