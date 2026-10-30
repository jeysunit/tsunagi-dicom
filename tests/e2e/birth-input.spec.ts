import { expect, test } from "@playwright/test";

// 検査一覧の詳細条件の生年月日の欄（docs/spec.md の 3.1「生年月日の入力」）。西暦と元号を受け、読み取り結果を欄の下に出す。
// 検査を選ぶ前の一覧の条件なので、年齢は画面を開いた日で数える。画面の今日を 2026/10/29 に止めて確かめる。
// 頁の URL の引数は今までどおり YYYY-MM-DD。検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-29T12:00:00+09:00"));
});

test("詳細条件の生年月日：S50/05/14 は読み取り結果を出して URL の birth を 1975-05-14 にし、H31/05/01 は誤りを出して条件にしない", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await page.getByTestId("filter-more").click();
  const birth = page.getByTestId("filter-birth");
  await expect(birth).toHaveAttribute("type", "text");
  await expect(birth).toHaveAttribute("inputmode", "text");
  await expect(birth).toHaveAttribute("autocomplete", "off");

  await birth.fill("S50/05/14");
  const hint = page.getByTestId("filter-birth-hint");
  await expect(hint).toHaveText("1975/05/14（昭50・51歳）");
  await expect(birth).toHaveAttribute("aria-describedby", (await hint.getAttribute("id"))!);
  await expect(birth).not.toHaveAttribute("aria-invalid");
  await expect(page).toHaveURL(/[?&]birth=1975-05-14(&|$)/);
  await expect(page.getByTestId("filter-more-count")).toHaveText("（1）");

  await birth.fill("昭和50年5月14日");
  await expect(hint).toHaveText("1975/05/14（昭50・51歳）");
  await expect(page).toHaveURL(/[?&]birth=1975-05-14(&|$)/);

  await birth.fill("H31/05/01");
  const msg = page.getByTestId("filter-birth-msg");
  await expect(msg).toHaveText("生年月日が平成の範囲にありません。平成は 2019/04/30 までです。令和1年は 2019/05/01 からです。");
  await expect(hint).toHaveCount(0);
  await expect(birth).toHaveAttribute("aria-invalid", "true");
  await expect(birth).toHaveAttribute("aria-describedby", (await msg.getAttribute("id"))!);
  await expect(msg).not.toHaveAttribute("role", "alert");
  // 読めない入力は条件にしない（URL から birth が外れ、一覧は全件に戻る）
  await expect(page).not.toHaveURL(/[?&]birth=/);
  await expect(page.getByTestId("study-count")).toHaveText("8");

  await birth.fill("2026/10/30");
  await expect(msg).toHaveText("生年月日が今日より後です。日付を確かめてください。");

  await birth.fill("");
  await expect(hint).toHaveCount(0);
  await expect(msg).toHaveCount(0);
});

test("URL の birth（YYYY-MM-DD）から開くと、欄に 1975/05/14 の形で入り、読み取り結果を出す", async ({ page }) => {
  await page.goto("/?birth=1975-05-14");
  await expect(page.getByTestId("filter-birth")).toHaveValue("1975/05/14");
  await expect(page.getByTestId("filter-birth-hint")).toHaveText("1975/05/14（昭50・51歳）");
  await expect(page).toHaveURL(/[?&]birth=1975-05-14(&|$)/);
});
