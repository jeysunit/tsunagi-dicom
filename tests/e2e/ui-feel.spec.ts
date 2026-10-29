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

const nav = (page: Page) => page.getByRole("navigation", { name: "ページ" });
const rows = (page: Page) => page.getByTestId("study-table").locator("tbody > tr[data-study-uid]");
const bg = (page: Page, selector: string) => page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);

test("今いる頁：左のナビの項目に aria-current と選んだ行の形、ブラウザのタブの題名は頁ごと", async ({ page }) => {
  await asAdmin(page);
  await expect(page).toHaveTitle("検査一覧 - tsunagi-dicom");
  const current = nav(page).locator("[aria-current=page]");
  await expect(current).toHaveCount(1);
  await expect(current).toHaveAttribute("href", "/");
  // 色だけで示さない：太字と左の線（左のナビの現在地。docs/design-system/menu.md）
  expect(await current.evaluate((el) => getComputedStyle(el).fontWeight)).toBe("700");
  expect(await current.evaluate((el) => getComputedStyle(el).borderLeftWidth)).toBe("3px");
  const other = nav(page).locator("a[href='/received']");
  await expect(other).not.toHaveAttribute("aria-current", /.*/);
  expect(await other.evaluate((el) => getComputedStyle(el).fontWeight)).not.toBe("700");

  for (const [href, title] of [
    ["/received", "受信一覧"],
    ["/sent", "送信一覧"],
    ["/modalities", "接続先"],
    ["/admin/viewers", "ビューア設定"],
    ["/version", "バージョン情報"],
  ] as const) {
    await nav(page).locator(`a[href='${href}']`).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page).toHaveTitle(`${title} - tsunagi-dicom`);
    await expect(nav(page).locator("[aria-current=page]")).toHaveAttribute("href", href);
    // 頁の見出しの大きさは1つにそろえる（20px・太字）
    const h1 = page.locator("main h1").first();
    expect(await h1.evaluate((el) => getComputedStyle(el).fontSize)).toBe("20px");
  }
});

test("左のナビ：本文の左に幅 208px で置き、群の名前を出す。上の帯のボタンで 56px に閉じ、読み込み直しても閉じたまま", async ({ page }) => {
  await asAdmin(page);
  const side = nav(page);
  const main = page.locator("main").first();
  const sideBox = (await side.boundingBox())!;
  const mainBox = (await main.boundingBox())!;
  expect(sideBox.x + sideBox.width).toBeLessThanOrEqual(mainBox.x + 1);
  expect(Math.round(sideBox.width)).toBe(208);
  for (const group of ["業務", "接続", "管理"]) await expect(side.getByText(group, { exact: true })).toBeVisible();
  // 上の帯には、画面への道を置かない
  await expect(page.locator("header").getByRole("link", { name: "受信一覧" })).toHaveCount(0);

  const toggle = page.getByTestId("nav-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.round((await side.boundingBox())!.width)).toBe(56);
  // 閉じても項目は押せて、名前は読み上げと title に残る
  await expect(side.getByRole("link", { name: "受信一覧" })).toHaveAttribute("title", "受信一覧");
  await page.reload();
  await expect(page.getByTestId("nav-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.round((await nav(page).boundingBox())!.width)).toBe(56);
  await page.getByTestId("nav-toggle").click();
  await expect.poll(async () => Math.round((await nav(page).boundingBox())!.width)).toBe(208);
});

test("左のナビ：390px の画面では閉じた形で始め、そこで開いても広い画面の形は変えない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await asAdmin(page);
  const toggle = page.getByTestId("nav-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.poll(async () => Math.round((await nav(page).boundingBox())!.width)).toBe(56);
  await toggle.click();
  await expect.poll(async () => Math.round((await nav(page).boundingBox())!.width)).toBe(208);
  await toggle.click();
  await expect.poll(async () => Math.round((await nav(page).boundingBox())!.width)).toBe(56);
  // 狭い画面で閉じたことは覚えない。広い画面で開き直すと、開いた形で始まる
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.reload();
  await expect(page.getByTestId("nav-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => Math.round((await nav(page).boundingBox())!.width)).toBe(208);
});

test("左のナビ：低い画面でも、末尾の項目まで届く（ナビの中でスクロールする）", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 300 });
  await asAdmin(page);
  const side = nav(page);
  expect(await side.evaluate((el) => getComputedStyle(el).overflowY)).toBe("auto");
  // 最後の項目（管理の群のバージョン情報）に、ナビの中のスクロールで届いて押せる
  const last = side.getByRole("link").last();
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect(nav(page).locator("[aria-current=page]")).toHaveAttribute("href", "/version");
});

test("左のナビ：頁を移る待ちの間は、閉じた幅でも、項目の絵の場所に待ちの印を出す", async ({ page }) => {
  await asAdmin(page);
  await page.getByTestId("nav-toggle").click();
  await expect.poll(async () => Math.round((await nav(page).boundingBox())!.width)).toBe(56);
  // 受信一覧の頁の取得を遅らせる（頁の切り替えが 0.3 秒を超えて待つ）
  await page.route("**/received**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  const link = nav(page).locator("a[href='/received']");
  await link.click();
  await expect(link.getByTestId("spinner")).toBeVisible();
  await expect(page).toHaveURL(/\/received$/);
  await page.getByTestId("nav-toggle").click();
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

test("押している間の手応え：ボタンは影を持たず 1px 沈み、絞り込みの並びは内側に影。枠のボタンは白い地", async ({ page }) => {
  await asAdmin(page);
  await expect(rows(page).first()).toBeVisible();
  const style = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => {
      const s = getComputedStyle(el);
      // Tailwind CSS v4 の translate-* は、CSS の translate の属性（transform ではない）
      return { translate: s.translate, shadow: s.boxShadow };
    });
  // 見える影があるか（Tailwind CSS v4 は、影の無い形も透明の影を並べて書く。色の透明度が 0 でない影を探す）
  const shadowVisible = (v: string) => v !== "none" && v.split(/,(?![^(]*\))/).some((part) => !/rgba\([^)]*,\s*0\)/.test(part));

  // 「詳細条件」（枠のボタンの形）：影は持たない（部品集の .btn）。押している間は 1px 沈む。離すと戻る
  const before = await style("filter-more");
  expect(shadowVisible(before.shadow)).toBe(false);
  expect(before.translate).toBe("none");
  await page.getByTestId("filter-more").hover();
  await page.mouse.down();
  await expect.poll(async () => (await style("filter-more")).translate).toBe("0px 1px");
  expect(shadowVisible((await style("filter-more")).shadow)).toBe(false);
  await page.mouse.up();
  await expect.poll(async () => (await style("filter-more")).translate).toBe("none");

  // 絞り込みの並びのボタンは、並びを崩さないよう沈めずに内側の影
  await page.getByTestId("modality-MR").hover();
  await page.mouse.down();
  await expect.poll(async () => (await style("modality-MR")).shadow).toContain("inset");
  expect((await style("modality-MR")).translate).toBe("none");
  await page.mouse.up();
  await page.getByTestId("modality-all").click();

  // 共通のボタン（受け取りの「読み直す」。前は詳細の「UID」のボタンで確かめていた。#57）も同じ手応え。
  // 枠のボタンの地は白（明るい地の上で、押せる物の形に見せる）
  await page.goto("/received");
  const reload = page.getByTestId("received-reload");
  expect(await reload.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
  await reload.hover();
  await page.mouse.down();
  await expect.poll(() => reload.evaluate((el) => getComputedStyle(el).translate)).toBe("0px 1px");
  await page.mouse.up();
  await expect.poll(() => reload.evaluate((el) => getComputedStyle(el).translate)).toBe("none");
  await page.goto("/");
  await expect(rows(page)).toHaveCount(8);

  // 動きを減らす設定では沈めない（地の色と影の変化だけ）
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByTestId("filter-more").hover();
  await page.mouse.down();
  await expect.poll(async () => shadowVisible((await style("filter-more")).shadow)).toBe(false);
  expect((await style("filter-more")).translate).toBe("none");
  await page.mouse.up();
  await page.emulateMedia({ reducedMotion: null });
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

test("件数の行：検索の欄が空でも入っていても、件数と自動更新は条件の行とは別の行の同じ位置にある（#56）", async ({ page }) => {
  await asAdmin(page);
  await expect(rows(page)).toHaveCount(8);
  const place = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top) };
    });
  const search = page.getByTestId("study-search");
  await expect(search).toHaveValue("");
  const emptyCount = await place("study-count");
  const emptyRefresh = await place("list-refresh");
  await search.fill("JP-TEST-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");
  expect(await place("study-count")).toEqual(emptyCount);
  expect(await place("list-refresh")).toEqual(emptyRefresh);
  // 幅が狭くても、件数の行は条件の行の下に別の行として出る
  const filters = await page.getByTestId("study-filters").boundingBox();
  expect(emptyCount.y).toBeGreaterThanOrEqual(Math.round(filters!.y + filters!.height));

  // 狭い幅（折り返す）でも、件数の行は条件の行の下にあり、横にはみ出さない。詳細条件を開いても同じ
  await page.setViewportSize({ width: 700, height: 800 });
  await page.getByTestId("filter-more").click();
  const narrowFilters = await page.getByTestId("study-filters").boundingBox();
  const narrowCount = await page.getByTestId("study-count").boundingBox();
  expect(narrowCount!.y).toBeGreaterThanOrEqual(narrowFilters!.y + narrowFilters!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
  // 旧：MR を押すと CT から MR に替わった（2 件）→ 新：モダリティは複数選べて押すと足される（CT と MR で 8 件）。
  // 取り直しが要るよう、まだ読んでいない組み合わせにする
  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("progress-bar")).toBeVisible();
  await expect(page.getByTestId("study-count")).toHaveText("—");
  await expect(page.getByTestId("study-table").locator("tbody")).toHaveAttribute("data-dim", "true");
  await expect(page.getByTestId("pending-text")).toContainText("読み込み中");
  // 終われば消える（画面全体を覆う幕は出さない）
  await expect(page.getByTestId("study-count")).toHaveText("8", { timeout: 10_000 });
  await expect(page.getByTestId("progress-bar")).toHaveCount(0);
  await page.unroute("**/api/studies?*");
});

// 画面の言葉は docs/spec.md の 2.2 の用語集から選ぶ。用語集で「使わない言い方」とした言葉が、画面に出ていないことを確かめる。
// 前の役割の名前のうち「医師」は、見本の紹介医の名前（試験 医師）に含まれるので、ここでは見ない（検証モードの帯に無いことは
// tests/e2e/home.spec.ts で見る）
const RETIRED_WORDS = [
  "すべての項目",
  "技師",
  "閲覧",
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
  // 画面の言葉の用語集（docs/design-system/glossary.md）で外した言葉
  "待機中",
  "既定",
  "AE タイトル",
  "頁",
  "患者氏名",
  "消去",
  // 値の修正の2種類の呼び名（画面は「患者情報修正」「検査情報修正」。docs/spec.md の 2.2）
  "属性の訂正",
  "中身の訂正",
  "再送せず",
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
  await page.getByTestId("series-open").first().click();
  await page.getByTestId("study-tags-open").click();
  await expect(page.getByTestId("all-values")).toContainText("0010,0020");
  await collect("詳細の UID と検査のタグ");
  for (const path of ["/received", "/sent", "/modalities", "/admin/viewers", "/version"]) {
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

/** 計算した色（`rgb(r, g, b)`）の相対輝度（WCAG 2.2） */
function luminance(rgb: string): number {
  const m = rgb.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(m, rgb).not.toBeNull();
  const [r, g, b] = m!.slice(1, 4).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
const contrastOf = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

test("入力欄・選択欄・枠のボタンの枠は、まわりの地との対比が 3:1 以上（WCAG 2.2 の 1.4.11）。明るい地と暗い地", async ({ page }) => {
  await asAdmin(page);
  // 色の遷移（100ms）の途中の色を読まない（枠なしのボタンは絵・字の色が遷移する）
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(rows(page)).toHaveCount(8);
  /**
   * 見えている部品ごとに、枠の色と、部品の外側の地を読む。地は親をたどって透けていない地まで重ね（透ける地は上に重ねる）、
   * 色の書き方（rgb・oklab など）に関わらず、1 画素の canvas に塗って sRGB の値にする
   */
  const measure = (where: string) =>
    page
      .locator("input[data-slot=input], select, textarea, button[data-slot=button][class*='border'], [data-testid=filter-more]")
      .evaluateAll(
        (els, label) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
          const paint = (colors: string[]) => {
            ctx.clearRect(0, 0, 1, 1);
            for (const c of colors) {
              ctx.fillStyle = c;
              ctx.fillRect(0, 0, 1, 1);
            }
            const d = ctx.getImageData(0, 0, 1, 1).data;
            return { rgb: `rgb(${d[0]}, ${d[1]}, ${d[2]})`, alpha: d[3]! };
          };
          return els
            // 見えていて、押せるもの。押せない物は対象外（WCAG 2.2 の 1.4.11 は無効の部品を除く。部品集の無効は枠 border・地 surface・字 label）。
            // 枠なし .btn-ghost は透明の枠 1px を持つ。枠では示せないので、枠の代わりに絵・字の色（currentColor）を地と比べる
            .filter((el) => {
              const s = getComputedStyle(el);
              return (el as HTMLElement).offsetParent !== null && !(el as HTMLButtonElement).disabled && s.borderTopWidth !== "0px";
            })
            .map((el) => {
              const layers: string[] = [];
              for (let outer = el.parentElement; outer; outer = outer.parentElement) {
                const c = getComputedStyle(outer).backgroundColor;
                const { alpha } = paint([c]);
                if (alpha === 0) continue;
                layers.unshift(c);
                if (alpha === 255) break;
              }
              const bg = paint(["rgb(255, 255, 255)", ...layers]).rgb;
              const s = getComputedStyle(el);
              const ghost = s.borderTopColor === "rgba(0, 0, 0, 0)";
              const border = paint([bg, ghost ? s.color : s.borderTopColor]).rgb;
              const id = el.getAttribute("data-testid") ?? el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 12) ?? "";
              return { name: `${label} ${ghost ? "枠なし " : ""}${el.tagName.toLowerCase()} ${id}`, border, bg };
            });
        },
        where,
      );
  const check = async (where: string) => {
    const found = await measure(where);
    expect(found.length, where).toBeGreaterThan(0);
    for (const f of found) expect(contrastOf(f.border, f.bg), `${f.name}：枠（枠なしは絵・字）${f.border}・地 ${f.bg}`).toBeGreaterThanOrEqual(3);
  };
  for (const theme of ["light", "dark"] as const) {
    await page.goto("/");
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await page.getByTestId("filter-more").click();
    await expect(page.getByTestId("filter-more-panel")).toBeVisible();
    await check(`${theme} 検査一覧`);
    await page.goto("/admin/viewers");
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    await check(`${theme} ビューア設定`);
  }
});
