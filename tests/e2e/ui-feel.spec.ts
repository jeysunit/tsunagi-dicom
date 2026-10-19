import { expect, test, type Page } from "@playwright/test";

// 画面の振る舞いの決まり（docs/spec.md の 2.3・3.1。2026-10-20 の画面の見直し）：
// 今いる頁の印と頁ごとのタブの題名、押せる物の手応え（カーソル・hover・押している間）、選んだ行の見分け、
// 一覧の列（患者 ID・生年月日・年齢・性別を切らない）。検証モード（AUTH_MODE=dev）とモックに対して流す。

test.describe.configure({ mode: "serial" });

async function asAdmin(page: Page) {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: "管理者" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

const nav = (page: Page) => page.getByRole("navigation", { name: "頁" });
const rows = (page: Page) => page.getByTestId("study-table").locator("tbody > tr[data-study-uid]");
const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

test("今いる頁：ナビゲーションの項目に aria-current とタブの形、ブラウザのタブの題名は頁ごと", async ({ page }) => {
  await asAdmin(page);
  await expect(page).toHaveTitle("検査一覧 - tsunagi-dicom");
  const current = nav(page).locator("[aria-current=page]");
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", "/");
  // 色だけで示さない：太字と下の線
  expect(await current.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("700");
  expect(await current.evaluate((el) => getComputedStyle(el).borderBottomWidth)).toBe("2px");
  const other = nav(page).locator("a[href='/received']");
  await expect(other).not.toHaveAttribute("aria-current", /.*/);
  expect(await other.evaluate((el) => getComputedStyle(el).fontWeight)).not.toBe("700");

  for (const [href, title] of [
    ["/received", "受信一覧"],
    ["/modalities", "接続先"],
    ["/admin/viewers", "ビューア設定"],
  ] as const) {
    await nav(page).locator(`a[href='${href}']`).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page).toHaveTitle(`${title} - tsunagi-dicom`);
    await expect(nav(page).locator("[aria-current=page]")).toHaveAttribute("href", href);
    // 頁の見出しの大きさは1つにそろえる（18px・太字）
    const h1 = page.locator("main h1").first();
    expect(await h1.evaluate((el) => getComputedStyle(el).fontSize)).toBe("18px");
  }
});

test("押せる物：カーソルは指の形、押せないときは禁止の形。hover で地が変わる", async ({ page }) => {
  await asAdmin(page);
  await expect(rows(page).first()).toBeVisible();
  const chip = page.getByTestId("modality-CT");
  expect(await chip.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  const more = page.getByTestId("filter-more");
  expect(await more.evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");
  expect(await rows(page).first().getByTestId("open-menu").evaluate((el) => getComputedStyle(el).cursor)).toBe("pointer");

  // hover の前と後で地の色が違う（前の hover は白い地との差が 1.12:1 で、ほぼ見えなかった）
  await page.mouse.move(0, 0);
  const before = await more.evaluate((el) => getComputedStyle(el).backgroundColor);
  await more.hover();
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(before);

  // 押せないボタン：禁止の形のカーソル（globals.css の1か所の決まり。頁に押せないボタンを1つ置いて確かめる）
  const cursor = await page.evaluate(() => {
    const b = document.createElement("button");
    b.disabled = true;
    b.textContent = "x";
    document.querySelector("main")!.appendChild(b);
    const c = getComputedStyle(b).cursor;
    b.remove();
    return c;
  });
  expect(cursor).toBe("not-allowed");
});

test("選んだ行：主の色の薄い地と左の縦線。hover の行の地とは違う", async ({ page }) => {
  await asAdmin(page);
  await expect(rows(page)).toHaveCount(8);
  await rows(page).nth(0).click();
  await expect(rows(page).nth(0)).toHaveAttribute("aria-selected", "true");
  await rows(page).nth(2).hover();
  const selectedBg = await bg(page, "tr[data-selected]");
  const hoverBg = await rows(page).nth(2).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(selectedBg).not.toBe(hoverBg);
  expect(selectedBg).not.toBe("rgba(0, 0, 0, 0)");
  // 左の縦線（3px の主の色）
  const shadow = await rows(page).nth(0).locator("td").first().evaluate((el) => getComputedStyle(el).boxShadow);
  expect(shadow).toContain("inset");
  expect(shadow).toContain("3px");
  // 詳細の見出しにも同じ縦線
  const head = page.getByTestId("detail-head");
  expect(await head.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("3px");
});

test("待ちの表示：0.3 秒たっても終わらなければ一覧の上に細い帯、古い行を薄く、件数は「—」。すぐ終われば出さない", async ({ page }) => {
  await asAdmin(page);
  await expect(rows(page)).toHaveCount(8);
  // すぐ終わる取り直し：印を出さない（ちらつかない）
  const quick = page.waitForResponse((r) => r.url().includes("/api/studies?") && r.ok());
  await page.getByTestId("modality-CT").click();
  await quick;
  await expect(page.getByTestId("study-count")).toHaveText("6");
  await expect(page.getByTestId("progress-bar")).toHaveCount(0);

  // 遅い取り直し：一覧の API の答えを 1.5 秒遅らせる
  await page.route("**/api/studies?*", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("progress-bar")).toBeVisible();
  await expect(page.getByTestId("study-count")).toHaveText("—");
  await expect(page.getByTestId("study-table").locator("tbody")).toHaveAttribute("data-dim", "true");
  await expect(page.getByTestId("pending-text")).toContainText("読み込み中");
  // 終われば消える（画面全体を覆う幕は出さない）
  await expect(page.getByTestId("study-count")).toHaveText("2", { timeout: 10_000 });
  await expect(page.getByTestId("progress-bar")).toHaveCount(0);
  await page.unroute("**/api/studies?*");
});

// 画面の言葉は docs/spec.md の 2.2 の用語集から選ぶ。用語集で「使わない言い方」とした言葉が、画面に出ていないことを確かめる。
// 役割の名前（医師・技師・閲覧）と「すべての項目」は、役割と詳細のパネルを直す次の PR で外すので、ここでは見ない
const RETIRED_WORDS = [
  "受け取り",
  "機器",
  "ビューアの既定",
  "自分の設定",
  "暗い地",
  "地の色",
  "読んでいる",
  "合う検査が無い",
  "読めなかった",
  "つながらな",
  "つながった",
  "この役割では",
  "管理者だけ",
  "一覧で開く",
  "ビューアを選ぶ",
  "次から",
  "覚えを消す",
  "送る",
  "送り先",
  "送った",
  "やめる",
  "書き出し",
  "取り込み",
  "確かめ",
  "つながるか",
  "住所",
  "結果が分からない",
  "読み直す",
  "要求の ID",
  "届いていた",
  "利用者名",
  "表示の名前",
  "止めている",
  "一時停止を解く",
  "登録あり",
  "最後のログイン",
  "作った日",
  "確認の番号",
  "いまのパスワード",
  "1週間",
  "全期間",
  "期間の指定",
  "詳しく",
  "詳しい条件",
  "横断の検索",
  "検査の記述",
  "すべての DICOM の値",
  "患者 ID",
  "監査の外",
];

test("画面の言葉：用語集で外した言葉が、検証モードのどの頁にも出ない", async ({ page }) => {
  await asAdmin(page);
  const seen: string[] = [];
  const collect = async (where: string) => {
    // 見える文字・読み上げの名前（aria-label）・title の全部
    const text = await page.evaluate(() => {
      const parts = [document.body.innerText, document.title];
      for (const el of document.querySelectorAll("[aria-label], [title], [placeholder]")) {
        parts.push(el.getAttribute("aria-label") ?? "", el.getAttribute("title") ?? "", el.getAttribute("placeholder") ?? "");
      }
      return parts.join("\n");
    });
    for (const w of RETIRED_WORDS) if (text.includes(w)) seen.push(`${where}: ${w}`);
  };
  await expect(rows(page)).toHaveCount(8);
  await page.getByTestId("filter-more").click();
  await page.getByTestId("date-range").click();
  await collect("検査一覧");
  await page.goto("/");
  await rows(page).first().click();
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  await page.getByTestId("study-detail").getByTestId("open-menu").click();
  await collect("詳細とビューアのメニュー");
  await page.keyboard.press("Escape");
  await page.getByTestId("detail-all-items-toggle").click();
  await page.getByRole("button", { name: "DICOM タグ" }).click();
  await expect(page.getByTestId("all-values")).toContainText("0010,0020");
  await collect("詳細の項目");
  await page.getByTestId("detail-all-items-toggle").click();
  for (const path of ["/received", "/modalities", "/admin/viewers"]) {
    await page.goto(path);
    if (path === "/modalities") {
      await page.locator('[data-modality="dtg"]').getByTestId("echo").click();
      await expect(page.locator('[data-modality="dtg"]').getByTestId("echo-result")).toBeVisible();
      await page.locator('[data-modality="offline"]').getByTestId("echo").click();
      await expect(page.locator('[data-modality="offline"]').getByTestId("echo-result")).toBeVisible();
    }
    await collect(path);
  }
  expect(seen).toEqual([]);
});

test("一覧の列：患者 ID・生年月日・年齢・性別は切らない（1280px と 1024px）", async ({ page }) => {
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 720 });
    await asAdmin(page);
    await expect(rows(page)).toHaveCount(8);
    for (const id of ["patient-id", "patient-birth", "patient-age", "patient-sex"]) {
      const cells = page.getByTestId(id);
      const cut = await cells.evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
      expect(cut, `${id} (${width}px)`).toEqual([]);
    }
    // ID は「…」で切らない
    expect(await page.getByTestId("patient-id").first().evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe("ellipsis");
  }
});
