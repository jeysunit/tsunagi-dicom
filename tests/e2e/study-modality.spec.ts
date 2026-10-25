import { expect, test, type Page } from "@playwright/test";

// モダリティを複数選んで絞る（docs/spec.md の 3.1）。検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。

async function asGeneral(page: Page) {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: "一般" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
  await expect(page.getByTestId("study-count")).toHaveText("8");
}

/** 見出しの文字の括弧の中の数（`CT (6)` → 6） */
const headCount = async (page: Page, id: string) => Number(/\((\d+)/.exec((await page.getByTestId(id).innerText()) ?? "")?.[1]);

test("モダリティは複数選べる：押すと足され、もう一度押すと外れ、全部外すと「すべて」。URL に残る", async ({ page }) => {
  await asGeneral(page);
  const ct = await headCount(page, "modality-CT");
  const mr = await headCount(page, "modality-MR");
  expect(ct + mr).toBe(8);

  await page.getByTestId("modality-CT").click();
  await expect(page.getByTestId("study-count")).toHaveText(String(ct));
  await page.getByTestId("modality-MR").click();
  // どれかに合う検査（CT または MR）
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("modality-CT")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("modality-MR")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("modality-all")).toHaveAttribute("aria-pressed", "false");
  await expect(page).toHaveURL(/modality=CT(%2C|,)MR/);

  // 群ごとの件数は、その群だけの数のまま
  expect(await headCount(page, "modality-CT")).toBe(ct);
  expect(await headCount(page, "modality-MR")).toBe(mr);

  // 開き直しても同じ
  await page.reload();
  await expect(page.getByTestId("modality-CT")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("modality-MR")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("study-count")).toHaveText("8");

  // 外すと、残りの群だけ。全部外すと「すべて」
  await page.getByTestId("modality-CT").click();
  await expect(page.getByTestId("study-count")).toHaveText(String(mr));
  await expect(page.getByTestId("modality-CT")).toHaveAttribute("aria-pressed", "false");
  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("modality-all")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page).not.toHaveURL(/modality=/);

  // 「すべて」を押すと、選んだ群が全部外れる
  await page.getByTestId("modality-CT").click();
  await page.getByTestId("modality-MR").click();
  await page.getByTestId("modality-all").click();
  await expect(page.getByTestId("modality-CT")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("modality-MR")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("study-count")).toHaveText("8");
});

test("URL の modality に複数を書いて開ける（コンマ区切り。知らない名前は捨てる）", async ({ page }) => {
  await asGeneral(page);
  await page.goto("/?modality=MR,US,XX");
  await expect(page.getByTestId("modality-MR")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("modality-US")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("modality-CT")).toHaveAttribute("aria-pressed", "false");
  const mr = await headCount(page, "modality-MR");
  const us = await headCount(page, "modality-US");
  await expect(page.getByTestId("study-count")).toHaveText(String(mr + us));
});

test("DOC・SR は一覧の上の見出しに出さず、詳細条件の中で選ぶ。上の見出しと同じ選びに足される", async ({ page }) => {
  await asGeneral(page);
  const band = page.getByTestId("study-filters");
  // 一覧の上：すべて・CT・MR・CR/DX・US・ES・MG
  for (const id of ["modality-all", "modality-CT", "modality-MR", "modality-CR/DX", "modality-US", "modality-ES", "modality-MG"]) {
    await expect(band.getByTestId(id)).toBeVisible();
  }
  await expect(band.getByTestId("modality-DOC")).toHaveCount(0);
  await expect(band.getByTestId("modality-SR")).toHaveCount(0);

  // 詳細条件の中：DOC・SR
  await band.getByTestId("filter-more").click();
  const panel = page.getByTestId("filter-more-panel");
  await expect(panel.getByTestId("modality-DOC")).toBeVisible();
  await expect(panel.getByTestId("modality-SR")).toBeVisible();

  // CT に SR を足すと、CT または SR の検査（上の CT の見出しも押したまま）
  await page.getByTestId("modality-CT").click();
  await panel.getByTestId("modality-SR").click();
  await expect(page.getByTestId("modality-CT")).toHaveAttribute("aria-pressed", "true");
  await expect(panel.getByTestId("modality-SR")).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/modality=CT(%2C|,)SR/);
  await expect(page.getByTestId("filter-more-count")).toHaveText("（1）");

  // 「すべて」で DOC・SR も外れる
  await page.getByTestId("modality-all").click();
  await expect(panel.getByTestId("modality-SR")).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("study-count")).toHaveText("8");
});

test("DOC・SR を URL で選んで開くと、詳細条件が開いていて、数に入る", async ({ page }) => {
  await asGeneral(page);
  await page.goto("/?modality=SR");
  await expect(page.getByTestId("filter-more-panel").getByTestId("modality-SR")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("filter-more-count")).toHaveText("（1）");
  await expect(page.getByTestId("modality-all")).toHaveAttribute("aria-pressed", "false");
});
