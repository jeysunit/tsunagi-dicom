import { expect, test, type Page } from "@playwright/test";

// 段 2 の検査の一覧（docs/spec.md の 3.1・3.2）：すぐ絞れる見出し・詳細のパネル・ビューアの選び分けと記憶。
// 検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。ビューアの覚えは試験のデータベースに残るので、
// 変えた覚えは同じ試験の中で戻し、順に流す。

test.describe.configure({ mode: "serial" });

/** サムネイルの写しがある検査（見本の 1 件目。JP-TEST-0004・2026-04-10・CT） */
const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

// 役割は管理者と一般の2つ（2026-10-20。docs/spec.md の 3.6）。前の医師・技師・閲覧で流していた試験は、一般で流す
async function asRole(page: Page, label: "管理者" | "一般") {
  await page.goto("/");
  const band = page.getByTestId("dev-mode-band");
  const button = band.getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

/** 詳細の見出し（患者バナーと UID の 1 行）の高さの上限（px）。バナーは氏名とかなの 2 行（約 58px）、UID の行は 24px のボタンを含む */
const BANNER_HEAD_MAX = 96;

const rows = (page: Page) => page.getByTestId("study-table").locator("tbody > tr[data-study-uid]");
const row = (page: Page, uid = STUDY) => page.locator(`tr[data-study-uid="${uid}"]`);

/** BFF の /api/viewers/open が移した先（ビューアの URL）。ビューアの宛先（例の名前）へは出ない */
let redirects: string[] = [];

test.beforeEach(async ({ context }) => {
  redirects = [];
  // 移る先への通信は、Playwright の route では止められない（移った後の要求は route を通らない）ので、
  // BFF の答え（302）を受けて移り先を控え、画面には移らずに返す。BFF の側の監査の記録は残る
  await context.route("**/api/viewers/open?**", async (route) => {
    const res = await route.fetch({ maxRedirects: 0 });
    redirects.push(res.headers()["location"] ?? `status ${res.status()}`);
    await route.fulfill({ status: 200, contentType: "text/plain", body: "opened" });
  });
});

/** 別のタブが開き、BFF がビューアの URL へ移したこと */
async function expectOpened(page: Page, action: () => Promise<void>, url: string | RegExp) {
  const before = redirects.length;
  const popup = page.waitForEvent("popup");
  await action();
  const opened = await popup;
  await expect.poll(() => redirects.length).toBeGreaterThan(before);
  const last = redirects.at(-1)!;
  if (typeof url === "string") expect(last).toBe(url);
  else expect(last).toMatch(url);
  await opened.close();
}

test("すぐ絞れる見出し：期間の指定・モダリティ・横断の検索。絞り込みは頁の URL に残る", async ({ page }) => {
  await asRole(page, "一般");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("date-all")).toHaveAttribute("aria-pressed", "true");

  await page.goto("/?date=range&from=2026-10-17&to=2026-10-17");
  await expect(page.getByTestId("date-range")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("study-count")).toHaveText("4");
  await expect(rows(page)).toHaveCount(4);

  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect(page).toHaveURL(/modality=MR/);

  await page.getByTestId("date-all").click();
  await page.getByTestId("modality-all").click();
  await page.getByTestId("study-search").fill("やまだ");
  await expect(page.getByTestId("study-count")).toHaveText("4");
  await expect(page).toHaveURL(/q=/);
  await page.getByTestId("study-search").fill("JP-TEST-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");

  // 開き直しても同じ絞り込み
  await page.reload();
  await expect(page.getByTestId("study-search")).toHaveValue("JP-TEST-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");

  await page.getByTestId("study-search").fill("該当しない語");
  // 文言は docs/spec.md の 2.2（合う検査が無い→該当する検査はありません）。条件をクリアで、すべての検査に戻る
  await expect(page.getByText("該当する検査はありません")).toBeVisible();
  await page.getByRole("button", { name: "条件をクリア" }).click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
});

test("0 件でも一覧の場所が分かる：表の枠と見出しの行を出し、空の案内は表の中。絞り込みが既定なら「条件をクリア」を出さない", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto(`/?${new URLSearchParams({ q: "該当しない語" })}`);
  const table = page.getByTestId("study-table");
  await expect(table.getByTestId("study-list-empty")).toBeVisible();
  await expect(table.locator("thead")).toContainText("患者ID");
  await expect(table.locator("thead")).toContainText("検査日時");
  await expect(rows(page)).toHaveCount(0);
  await expect(table.getByRole("button", { name: "条件をクリア" })).toBeVisible();
  // 表の枠は一覧の場所の大きさのまま（真っ白の場所にしない）
  const box = await page.getByTestId("study-list-scroll").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(200);

  // 画像サーバーに検査が 1 件も無いとき（絞り込みは既定）：案内だけを出し、戻す先の無い「条件をクリア」は出さない
  await page.route(/\/api\/studies$/, (route) =>
    route.fulfill({ json: { count: { count: 0, exact: true }, studies: [], facets: { modality: { all: 0 } } } }),
  );
  await page.getByRole("button", { name: "条件をクリア" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("study-count")).toHaveText("0");
  await expect(table.getByTestId("study-list-empty")).toBeVisible();
  await expect(page.getByRole("button", { name: "条件をクリア" })).toHaveCount(0);
  await expect(table.locator("thead")).toContainText("患者ID");
});

test("0 件の案内は、狭い画面でも見えている幅の中に出る（表が横にスクロールする幅でも、右の外に隠れない）", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await asRole(page, "一般");
  await page.goto(`/?${new URLSearchParams({ q: "該当しない語" })}`);
  const list = (await page.getByTestId("study-list-scroll").boundingBox())!;
  const empty = page.getByTestId("study-table").getByTestId("study-list-empty");
  await expect(empty).toBeVisible();
  for (const target of [empty, page.getByRole("button", { name: "条件をクリア" })]) {
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(list.x);
    expect(box.x + box.width).toBeLessThanOrEqual(list.x + list.width);
  }
});

// 期待の変更（1 件）：一覧の行のサムネイル（写しのある検査は画像・無い検査は印）の確かめを外した。
// 1 行 28px の一覧ではサムネイルの列を外したため（docs/spec.md の 3.1）。サムネイルは詳細のシリーズの横 1 列で確かめる（下の試験）。
test("一覧の行：氏名（漢字・かな）・和暦と年齢・シリーズ数と画像数", async ({ page }) => {
  await asRole(page, "一般");
  const r = row(page);
  await expect(r).toContainText("試験 髙子");
  await expect(r).toContainText("しけん たかこ");
  // 生年月日・年齢・性別は3つの列（2026-10-20 に1つの列から分けた。docs/spec.md の 3.1）
  await expect(r.getByTestId("patient-birth")).toHaveText("1960/07/15");
  await expect(r.getByTestId("patient-birth")).toHaveAttribute("title", "1960/07/15（昭和35年）");
  await expect(r.getByTestId("patient-age")).toHaveText("65歳");
  await expect(r.getByTestId("patient-sex")).toHaveText("女");
  await expect(r).toContainText("1 / 4");
  // 一覧の行にはサムネイルを出さない
  await expect(r.getByTestId("thumbnail")).toHaveCount(0);
  await expect(r.getByTestId("thumbnail-missing")).toHaveCount(0);
  // PN の元の形（^ と =）は画面に出さない
  expect(await page.locator("main").innerText()).not.toContain("^");
});

test("詳細のシリーズ：サムネイルが横に 1 列に並び、横にスクロールでき、まわりは暗い地", async ({ page }) => {
  await asRole(page, "一般");
  // シリーズが 2 つの検査（一覧の「2 / 6」の行）
  await page.locator("tr[data-study-uid]").filter({ hasText: "2 / 6" }).first().click();
  const strip = page.getByTestId("series-strip");
  await expect(strip.getByTestId("series-item")).toHaveCount(2);
  await expect(strip).toHaveCSS("background-color", "rgb(27, 27, 27)");
  const items = strip.getByTestId("series-item");
  // サムネイルは同じ高さに左から右へ並ぶ（縦に積まない）
  const boxes = await items.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
  expect(Math.abs(boxes[0]!.top - boxes[1]!.top)).toBeLessThan(1);
  expect(boxes[1]!.left).toBeGreaterThan(boxes[0]!.left);
  // 画像が出る（取れなければ印だけ）：シリーズごとに 1 つ
  await expect(strip.getByTestId("thumbnail").or(strip.getByTestId("thumbnail-missing"))).toHaveCount(2);
  // 横にスクロールする入れ物で、キーボードでもフォーカスを受ける
  const row = strip.getByTestId("series-row");
  expect(await row.evaluate((el) => getComputedStyle(el).overflowX)).toBe("auto");
  await row.focus();
  await expect(row).toBeFocused();
});

test("詳細のシリーズ：狭い幅（600px）でも、並びは 1 列のまま（縦に積まない）", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await asRole(page, "一般");
  await page.locator("tr[data-study-uid]").filter({ hasText: "2 / 6" }).first().click({ position: { x: 100, y: 12 } });
  const row = page.getByTestId("series-row");
  await expect(row).toBeVisible();
  const boxes = await page.getByTestId("series-item").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(new Set(boxes.map((t) => Math.round(t))).size).toBe(1);
});

// 戻した確かめ：一覧のサムネイルを外した（期待の変更 1）ときに外れた「実の画像が読めたか」を、詳細の横の並びで確かめる。
// 要素の数だけでなく、画像が実際に読めたこと（naturalWidth > 0）と、写しの無い検査は印だけであること
test("詳細のシリーズ：写しのある検査はサムネイルの画像が実際に読め、写しの無い検査は印だけ", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  const strip = page.getByTestId("series-strip");
  await expect(strip.getByTestId("series-item")).toHaveCount(1);
  const img = strip.getByTestId("thumbnail");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
  // まわりは暗い地
  await expect(img.locator("xpath=..")).toHaveCSS("background-color", "rgb(27, 27, 27)");
  await expect(strip.getByTestId("thumbnail-missing")).toHaveCount(0);

  // 写しの無い検査（1 行目以外のどれか）は印だけ
  const other = page.locator(`tr[data-study-uid]:not([data-study-uid="${STUDY}"])`).last();
  await other.click();
  await expect(page.getByTestId("study-detail")).not.toHaveAttribute("data-study-uid", STUDY);
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  await expect(page.getByTestId("series-strip").getByTestId("thumbnail-missing").first()).toBeVisible();
  await expect(page.getByTestId("series-strip").getByTestId("thumbnail")).toHaveCount(0);
});

// 期待の変更：毎回見る値（受付番号・紹介医など）は見出しに上げ、開け閉めは「UID」だけにした（docs/spec.md の 3.1・UX のレビューの H8）。
// 前は検査と患者の情報の 2 列を「すべての項目」の中で確かめていた。いまは見出しで確かめ、UID は「UID」を開いて確かめる
test("詳細のパネル：行のクリックで開き、見出しの要点と、UID・シリーズの並び（暗い地）を出す", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  const detail = page.getByTestId("study-detail");
  await expect(detail).toBeVisible();
  // 期待の変更（患者バナー。docs/design-system/components.md）：見出しは患者バナーにした。
  // バナー：氏名・かな・患者ID・生年月日と年齢・性別・受付番号・検査日時・モダリティと検査名。和暦・紹介医などは「検査の情報」へ移した
  const head = detail.getByTestId("detail-head");
  const banner = head.getByRole("region", { name: "患者" });
  await expect(banner).toContainText("試験 髙子");
  await expect(banner).toContainText("しけん たかこ");
  await expect(banner).toContainText("JP-TEST-0004");
  await expect(banner).toContainText("1960/07/15（65歳） 女");
  await expect(banner).toContainText("2026/04/10");
  await expect(banner).toContainText("CT");
  await expect(banner).not.toContainText("試験 医師");
  await expect(banner).not.toContainText("昭和35年");
  // バナーの項目は、見出しの並び（氏名・患者ID・生年月日・受付番号・検査日時・モダリティ）のとおり
  const labels = await banner.locator("dt").allTextContents();
  expect(labels).toEqual(["患者ID", "生年月日・性別", "受付番号", "検査日時", "モダリティ・検査名"]);
  // UID は、バナーの下の 1 行。高さは、バナー（氏名とかなの 2 行）と UID の 1 行ぶん
  expect(await head.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(BANNER_HEAD_MAX);
  // StudyInstanceUID は見出しに常に出る（開け閉めしない）。下の「UID」「DICOM タグ」のボタンは無い
  await expect(detail.getByTestId("detail-uid-toggle")).toHaveCount(0);
  await expect(detail.getByTestId("detail-tags-toggle")).toHaveCount(0);
  await expect(head.getByTestId("study-uid")).toContainText(STUDY);
  const uid = head.getByTestId("study-uid").locator("code");
  await expect(uid).toHaveCSS("font-size", "12px");
  await expect(uid).toHaveCSS("font-family", /mono|Mono|Courier/);
  const strip = detail.getByTestId("series-strip");
  await expect(strip.getByTestId("series-item")).toHaveCount(1);
  await expect(strip).toContainText("Chest Axial 5mm");
  await expect(strip).toHaveCSS("background-color", "rgb(27, 27, 27)");
  // 一般にもシリーズの画像の場所（主なタグ・すべてのタグ・検査のタグ）がある（前は医師に無かった。役割を2つにした。docs/spec.md の 3.6）
  await strip.getByTestId("series-open").first().click();
  await expect(detail.getByTestId("tag-set-study")).toHaveCount(1);

  // もう一度押しても閉じない（下の詳細は選んだ行のものを出し続ける）。Escape で選びを外すと案内に戻る
  // （期待の変更：行の下に開く形をやめ、もう一度押して閉じる動きを、Escape に替えた。docs/spec.md の 3.1）
  await row(page).click();
  await expect(detail).toBeVisible();
  await row(page).focus();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId("study-detail-empty")).toBeVisible();
});

// 詳細がどの検査のものか。UID の行は「UID」の中（閉じている）なので、詳細の枠に付けた data-study-uid で確かめる
const expectDetail = (page: Page, uid: string) => expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", uid);

test("上下に分ける：行を選ぶと下の詳細が替わり、一覧の行は動かない。頁全体はスクロールしない", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await asRole(page, "一般");
  await expect(rows(page)).toHaveCount(8);
  // 何も選んでいないときは、下に短い案内だけ
  await expect(page.getByTestId("study-detail-empty")).toBeVisible();
  await expect(page.getByTestId("study-detail")).toHaveCount(0);

  const noPageScroll = () =>
    page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight && document.body.scrollHeight <= window.innerHeight);
  expect(await noPageScroll()).toBe(true);

  const second = rows(page).nth(1);
  const secondUid = (await second.getAttribute("data-study-uid"))!;
  const before = await rows(page).nth(1).boundingBox();
  await rows(page).first().click();
  await expectDetail(page, (await rows(page).first().getAttribute("data-study-uid"))!);
  await second.click();
  await expectDetail(page, secondUid);
  // 行の位置は動かない（詳細は行の下に開かない。一覧は選んだだけではスクロールしない）
  const after = await rows(page).nth(1).boundingBox();
  expect(after).toEqual(before);
  expect(await page.getByTestId("study-list-scroll").evaluate((el) => el.scrollTop)).toBe(0);
  // 詳細が長くても頁は伸びない。一覧の中だけがスクロールする
  expect(await noPageScroll()).toBe(true);
  // 期待の変更（1 件）：一覧の中だけがスクロールすることの確かめを、高さ 900px から 600px の画面に替えた。
  // 1 行が 28px になり、見本の 8 件は 900px の高さの一覧に全部収まる（前は 65px で収まらなかった）ため。確かめる内容は同じ
  await page.setViewportSize({ width: 1280, height: 600 });
  expect(await noPageScroll()).toBe(true);
  const list = page.getByTestId("study-list-scroll");
  expect(await list.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // スクロールバーの出入りで画面が左右に寄らない
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollbarGutter)).toContain("stable");
});

test("上下に分ける：矢印の上下で行を移すと詳細が付いて替わり、Enter でビューアを開く。通り過ぎた行の詳細は読まない", async ({ page }) => {
  await asRole(page, "一般");
  const detailRequests: string[] = [];
  page.on("request", (req) => {
    const m = /\/api\/studies\/([0-9.]+)$/.exec(new URL(req.url()).pathname);
    if (m) detailRequests.push(m[1]!);
  });
  const uids = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-study-uid") ?? ""));

  await rows(page).first().click();
  await expectDetail(page, uids[0]!);
  await expect.poll(() => detailRequests.length).toBe(1);

  // 続けて3回：選びは行に付いて動くが、詳細を読むのは止まった行（4 番目）だけ
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(rows(page).nth(3)).toHaveAttribute("aria-selected", "true");
  await expect(rows(page).nth(3)).toBeFocused();
  await expectDetail(page, uids[3]!);
  await expect(page.getByTestId("series-item").first()).toBeVisible();
  expect(detailRequests).toEqual([uids[0], uids[3]]);

  await page.keyboard.press("ArrowUp");
  await expect(rows(page).nth(2)).toHaveAttribute("aria-selected", "true");
  await expectDetail(page, uids[2]!);

  // 一覧の端から外へは出ない
  await rows(page).first().focus();
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).first()).toBeFocused();

  // Enter で既定のビューア（別のタブ）
  await rows(page).first().focus();
  await expectOpened(page, () => page.keyboard.press("Enter"), /viewer\.example\.org\/(ohif|stone)\//);
});

test("上下に分ける：矢印で移した行は、一覧の見える所にスクロールする", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 560 });
  await asRole(page, "一般");
  await rows(page).first().click();
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
  const last = rows(page).last();
  await expect(last).toHaveAttribute("aria-selected", "true");
  const inView = await last.evaluate((el) => {
    const box = el.closest("[data-testid=study-list-scroll]")!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.bottom + 1;
  });
  expect(inView).toBe(true);
});

test("上下に分ける：境目をキーボードで動かせ、位置を覚える", async ({ page }) => {
  // 低い画面では、一覧の最小の高さのために境目の動く範囲が狭まる（別の試験で見る）。ここは高い画面で動きを見る
  await page.setViewportSize({ width: 1280, height: 1000 });
  await asRole(page, "一般");
  const handle = page.getByTestId("split-handle");
  await expect(handle).toHaveAttribute("role", "separator");
  await expect(handle).toHaveAttribute("aria-orientation", "horizontal");
  await expect(handle).toHaveAttribute("aria-valuenow", "60");
  const topHeight = () => page.locator("[data-split-root] > div").first().evaluate((el) => el.getBoundingClientRect().height);
  const h0 = await topHeight();

  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-valuenow", "65");
  expect(await topHeight()).toBeGreaterThan(h0);
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "55");
  expect(await topHeight()).toBeLessThan(h0);
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "20");
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "80");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(handle).toHaveAttribute("aria-valuenow", "25");

  // 開き直しても同じ位置
  await page.reload();
  await expect(page.getByTestId("split-handle")).toHaveAttribute("aria-valuenow", "25");

  // ドラッグでも動く
  const box = (await page.getByTestId("split-handle").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 5 });
  await page.mouse.up();
  expect(Number(await page.getByTestId("split-handle").getAttribute("aria-valuenow"))).toBeGreaterThan(25);
});

test("上下に分ける：狭い画面では一覧だけを出し、行を選ぶと詳細を一覧の上に重ねる", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await asRole(page, "一般");
  await expect(page.getByTestId("split-handle")).toBeHidden();
  await expect(page.getByTestId("detail-pane")).toBeHidden();
  const noPageScroll = () => page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
  expect(await noPageScroll()).toBe(true);

  // 表は幅が広く、行の中央は画面の外なので、見えている左の端を押す
  await row(page).click({ position: { x: 100, y: 20 } });
  await expect(page.getByTestId("study-detail")).toBeVisible();
  await expectDetail(page, STUDY);
  expect(await noPageScroll()).toBe(true);
  // 開いたら詳細へフォーカスが移り、背後の一覧は操作の対象から外れる（inert）。Tab を送っても一覧の行には出ない
  const pane = page.getByTestId("detail-pane");
  await expect(pane).toBeFocused();
  await expect(page.locator("[data-split-root] > div[inert]")).toHaveCount(1);
  // 段 3 で詳細の状態のボタンを外し、詳細の中の止まり先が減った。前の「Tab を 6 回」は、詳細の中の止まり先の数に
  // 頼っていたので、詳細の中の止まり先の数だけ Tab を送って詳細の中に留まること、さらに送っても一覧の行に出ないことに分けた
  const stops = await pane.evaluate(
    (el) => el.querySelectorAll("button:not([disabled]), a[href], input, [tabindex]:not([tabindex='-1'])").length,
  );
  expect(stops).toBeGreaterThan(1);
  for (let i = 0; i < stops - 1; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("tr[data-study-uid]"))).toBe(false);
  }
  expect(await pane.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest("tr[data-study-uid]"))).toBe(false);
  }
  await pane.focus();

  // 詳細の中からの Escape で閉じ、フォーカスは元の行へ戻り、一覧が操作できるに戻る
  await page.keyboard.press("Escape");
  await expect(pane).toBeHidden();
  await expect(row(page)).toBeFocused();
  await expect(page.locator("[data-split-root] > div[inert]")).toHaveCount(0);

  // 閉じるボタンでも同じ
  await row(page).click({ position: { x: 100, y: 20 } });
  await expect(pane).toBeFocused();
  await page.getByRole("button", { name: "詳細を閉じる" }).click();
  await expect(pane).toBeHidden();
  await expect(row(page)).toBeFocused();
});

test("上下に分ける：境目を上へ寄せても、一覧が最小の高さを保ち、絞り込みがはみ出さない", async ({ page }) => {
  // 期待の変更（左のナビ）：左のナビ（208px）を開くと、本文が狭くなって絞り込みが 1 段多く折り返す（日本語の字体で 3 段）。
  // その 1 段（約 32px）ぶん、画面の高さを 560px から 640px に上げた。ナビを閉じれば、これまでの高さでも収まる
  await page.setViewportSize({ width: 1280, height: 640 });
  await asRole(page, "一般");
  await row(page).click();
  const handle = page.getByTestId("split-handle");
  await handle.focus();
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "20");
  const g = await page.evaluate(() => {
    const r = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const filters = r("[data-testid=study-filters]");
    const list = r("[data-testid=study-list-scroll]");
    const handleRect = r("[data-testid=split-handle]");
    const detail = r("[data-testid=detail-pane]");
    return { filtersBottom: filters.bottom, listTop: list.top, listHeight: list.height, listBottom: list.bottom, handleTop: handleRect.top, handleBottom: handleRect.bottom, detailTop: detail.top };
  });
  // 一覧は 3 行ほどの高さ（14rem＝224px）を保つ
  expect(g.listHeight).toBeGreaterThanOrEqual(220);
  // 絞り込みは一覧の上、一覧は境目の上、境目は詳細の上（重ならない）
  expect(g.filtersBottom).toBeLessThanOrEqual(g.listTop + 1);
  expect(g.listBottom).toBeLessThanOrEqual(g.handleTop + 1);
  expect(g.handleBottom).toBeLessThanOrEqual(g.detailTop + 1);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight)).toBe(true);
});

test("詳細を見せるときは必ず記録が残る：A→B→A と戻っても、300ms 止まらない限り中身は出ず、止まれば取り直して記録する", async ({ page }) => {
  // サムネイルの取得（中継）も監査の記録になるので、数に混ざらないよう止める
  await page.route("**/api/dicom-web/**", (r) => r.abort());
  await asRole(page, "管理者");
  const uids = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-study-uid") ?? ""));
  // 記録の数（つなぎの確かめが数えた件数）。確かめの呼び出し自体が増やす分を、先に測って引く
  let calls = 0;
  const raw = async () => {
    calls++;
    return ((await (await page.request.get("/api/audit/verify")).json()) as { checked: number }).checked;
  };
  const c0 = await raw();
  const c1 = await raw();
  const perCall = c1 - c0;
  calls = 0;
  const recorded = async () => (await raw()) - calls * perCall;
  const detailGet = (uid: string) => page.waitForResponse((r) => r.url().endsWith(`/api/studies/${uid}`) && r.request().method() === "GET");

  const base = await recorded();
  const first = detailGet(uids[0]!);
  await rows(page).first().click();
  await first;
  const k = (await recorded()) - base;
  expect(k).toBeGreaterThan(0);
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");

  // A→B→A を 300ms より短く：戻った A の中身は出ない（キャッシュも残さない）。記録も増えない
  const gets: string[] = [];
  page.on("request", (req) => {
    const m = /\/api\/studies\/([0-9.]+)$/.exec(new URL(req.url()).pathname);
    if (m && req.method() === "GET") gets.push(m[1]!);
  });
  const again = detailGet(uids[0]!);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(rows(page).first()).toHaveAttribute("aria-selected", "true");
  // 期待の変更：読み込みの文字（前は「読んでいる」）は、0.3 秒たってから出す決まりにした（docs/spec.md の 2.3）ので、
  // 文字の有無ではなく、シリーズの中身を出していないこと（読み込み済みでないこと）で確かめる。確かめる中身は同じ
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "false");
  await expect(page.getByTestId("series-strip").getByTestId("series-item")).toHaveCount(0);
  expect(gets).toEqual([]);

  // 止まれば取り直し、そのとき記録が1件分（k）増える。B は一度も取っていない
  await again;
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  expect(await recorded()).toBe(base + 2 * k);
  await page.waitForTimeout(600);
  expect(await recorded()).toBe(base + 2 * k);
  expect(gets).toEqual([uids[0]]);
});

test("ビューアの覚えを変えても、詳細は取り直さず、「詳細を開いた」の記録は増えない", async ({ page }) => {
  // 段 2 では検査の状態の印で確かめていた。段 3 で状態の印を外したので、同じく一覧だけを読み直すビューアの覚えで確かめる
  await asRole(page, "一般");
  const gets: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "GET" && /\/api\/studies\/[0-9.]+$/.test(new URL(req.url()).pathname)) gets.push(req.url());
  });
  await row(page).click();
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  expect(gets).toHaveLength(1);
  const menu = page.getByTestId("study-detail").getByTestId("open-menu");
  await menu.click();
  await page.getByRole("menuitem", { name: "この検査は Stone で開く" }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveText("この検査: Stone");
  await page.waitForTimeout(500);
  expect(gets).toHaveLength(1);
  // 戻す
  await menu.click();
  await page.getByRole("menuitem", { name: /記憶を解除/ }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveCount(0);
  expect(gets).toHaveLength(1);
});

test("応答の順が逆になっても、古い応答が新しい選びを上書きしない", async ({ page }) => {
  await asRole(page, "一般");
  const uids = await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-study-uid") ?? ""));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // 1 番目の検査の詳細の応答だけを、あとから返す
  await page.route(`**/api/studies/${uids[0]}`, async (route) => {
    await gate;
    await route.continue();
  });
  await rows(page).first().click();
  await rows(page).nth(1).click();
  await expectDetail(page, uids[1]!);
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  release();
  await page.waitForTimeout(500);
  await expectDetail(page, uids[1]!);
  await expect(page.getByTestId("study-detail")).not.toHaveAttribute("data-study-uid", uids[0]!);
  // 見出しの StudyInstanceUID は、選んだ検査のものだけ
  await expect(page.getByTestId("detail-pane")).toContainText(uids[1]!);
  await expect(page.getByTestId("detail-pane")).not.toContainText(uids[0]!);
});

test("一般は DICOM タグを見られる。どの役割にも検査の状態の印は無い（段 3 で外した）", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  // 期待の変更（#57）：検査のタグは、シリーズの画像の場所の「検査のタグ」から見る
  await page.getByTestId("series-open").first().click();
  await page.getByTestId("tag-set-study").click();
  await expect(page.getByTestId("all-values")).toContainText("0010,0020");

  for (const role of ["管理者", "一般"] as const) {
    await asRole(page, role);
    await page.goto("/");
    await row(page).click();
    await expect(page.getByTestId("study-detail")).toBeVisible();
    await expect(page.locator("[data-testid^=state-], [data-testid^=status-], [data-testid=badge-urgent]")).toHaveCount(0);
    for (const word of ["未検像", "検像済", "未読", "既読", "ブックマーク"]) await expect(page.getByTestId("study-filters")).not.toContainText(word);
  }
});

test("ビューア：▶ と、ダブルクリックで既定のビューアを別のタブで開き、開いたことを記録する", async ({ page }) => {
  await asRole(page, "管理者");
  const before = await (await page.request.get("/api/audit/verify")).json();

  await expectOpened(
    page,
    () => row(page).getByTestId("open-default").click(),
    `https://viewer.example.org/ohif/viewer?StudyInstanceUIDs=${STUDY}`,
  );
  // 氏名のセル（段 3 で状態の列を外したので 3 番目）
  await expectOpened(page, () => row(page).locator("td").nth(2).dblclick(), /viewer\.example\.org\/ohif\/viewer/);

  const after = await (await page.request.get("/api/audit/verify")).json();
  expect(after.ok).toBe(true);
  expect(after.checked).toBeGreaterThan(before.checked);
});

test("ビューア：▾ から「この検査は次から Stone」と覚え、行に既定を出し、覚えを消せる", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: "この検査は Stone で開く" }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveText("この検査: Stone");

  await expectOpened(
    page,
    () => row(page).getByTestId("open-default").click(),
    `https://viewer.example.org/stone/index.html?study=${STUDY}`,
  );

  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: /記憶を解除/ }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveCount(0);

  // 外した確かめ：「閲覧には覚えさせる項目が無い」（閲覧の役割を無くした。2026-10-20）。DICOMweb URL のコピーの補いは残す
  await row(page).getByTestId("open-menu").click();
  await expect(page.getByRole("menuitem", { name: /DICOMweb URL をコピー/ })).toContainText("操作ログの対象外");
});

test("モダリティごとの既定のビューア：管理者が管理の画面で変え、ほかの役割は開けない", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto("/admin/viewers");
  await expect(page.getByText("管理者のみ利用できます")).toBeVisible();

  await asRole(page, "管理者");
  await page.getByRole("navigation", { name: "ページ" }).getByRole("link", { name: "ビューア設定" }).click();
  await expect(page).toHaveURL(/\/admin\/viewers$/);
  const ct = page.getByLabel("CT の標準のビューア");
  await expect(ct).toHaveValue("ohif");
  await ct.selectOption("stone");
  await expect(page.getByText("CT の標準のビューアを保存しました")).toBeVisible();

  await page.goto("/");
  await expectOpened(page, () => row(page).getByTestId("open-default").click(), /viewer\.example\.org\/stone\//);

  // 戻す
  await page.goto("/admin/viewers");
  await page.getByLabel("CT の標準のビューア").selectOption("ohif");
  await expect(page.getByText("CT の標準のビューアを保存しました")).toBeVisible();
});

// ---- 1 行の一覧・件数つきの絞り込み・詰めた詳細（docs/spec.md の 3.1） ----

const count = async (loc: ReturnType<Page["getByTestId"]>) => Number(/\((\d+)\)/.exec(await loc.innerText())![1]);
const headCount = async (page: Page) => Number(await page.getByTestId("study-count").innerText());
/**
 * 見出しを押したあとの一覧の取り直しが終わるまで待つ。件数と見出しの件数は同じ応答で替わる。
 * 待たないと、押す前の応答の値がたまたま期待と同じで通り抜け、古い見出しの件数を読んでしまう
 * （待ちの印は 0.3 秒たつまで出ないので、件数の表示だけでは新旧を見分けられない）
 */
const listSettled = (page: Page) => expect(page.getByRole("heading", { level: 1 }).and(page.locator("[data-fetching]"))).toHaveCount(0);

test("1 行の一覧：行の高さは 28px（14px の文字）、氏名の漢字とかなは別の列（かなは右）", async ({ page }) => {
  await asRole(page, "一般");
  await expect(rows(page)).toHaveCount(8);
  const heights = await rows(page).evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  for (const h of heights) {
    expect(h).toBeGreaterThanOrEqual(28);
    expect(h).toBeLessThanOrEqual(30);
  }
  await expect(page.getByTestId("study-table").locator("tbody td").first()).toHaveCSS("font-size", "14px");
  const r = row(page);
  const name = r.getByTestId("patient-name");
  const kana = r.getByTestId("patient-kana");
  await expect(name).toHaveText("試験 髙子");
  await expect(kana).toHaveText("しけん たかこ");
  // かなは漢字とは別のセル（別の列）で、漢字の右にある
  expect(await name.evaluate((el) => el.closest("td") === el.closest("tr")!.querySelector("td[data-testid=patient-kana]"))).toBe(false);
  const nb = (await name.boundingBox())!;
  const kb = (await kana.boundingBox())!;
  expect(kb.x).toBeGreaterThan(nb.x + nb.width - 1);
  expect(Math.abs(kb.y + kb.height / 2 - (nb.y + nb.height / 2))).toBeLessThan(8);
  // 見出しの行にも別の列
  // 列名は docs/spec.md の 2.2（かな→カナ）
  await expect(page.getByRole("columnheader", { name: "カナ" })).toBeVisible();
});

test("1 行の一覧：1280×720 の画面で、見える行が前（2 行）より多い。ビューアの部品も 1 行に収まり、押せる大きさは 24px 以上", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await asRole(page, "一般");
  await expect(rows(page)).toHaveCount(8);
  const visible = await page.evaluate(() => {
    const list = document.querySelector("[data-testid=study-list-scroll]")!.getBoundingClientRect();
    return [...document.querySelectorAll("tbody > tr[data-study-uid]")].filter((r) => {
      const b = r.getBoundingClientRect();
      return b.top >= list.top && b.bottom <= list.bottom + 1;
    }).length;
  });
  // 前（行の高さ 65px・一覧 224px）は 2 行。見本の検査は全部で 8 件
  expect(visible).toBeGreaterThanOrEqual(6);
  // ▶ 開く と ▾ は 24px 以上、行は 28px のまま
  for (const id of ["open-default", "open-menu"]) {
    const b = (await row(page).getByTestId(id).boundingBox())!;
    expect(b.height).toBeGreaterThanOrEqual(24);
    expect(b.width).toBeGreaterThanOrEqual(24);
  }
  expect((await row(page).boundingBox())!.height).toBeLessThanOrEqual(30);
  // 覚えたビューアの印が付いても、行は 28px のまま
  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: "この検査は Stone で開く" }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveText("この検査: Stone");
  expect((await row(page).boundingBox())!.height).toBeLessThanOrEqual(30);
  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: /記憶を解除/ }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveCount(0);
});

test("1 行の一覧：1 行に収まらない値は `…` で切り、全文は title。詳細のパネルでは切らない", async ({ page }) => {
  const long = "とても長い検査の記述".repeat(20);
  // 絞り込みで読み直したときの一覧の応答を、記述の長いものに替える（画面の API の形は変えない）
  await page.route("**/api/studies?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { studies: Record<string, unknown>[] };
    for (const s of body.studies) s.studyDescription = long;
    await route.fulfill({ response: res, json: body });
  });
  await asRole(page, "一般");
  await page.getByTestId("date-all").click(); // 押し直しでは読み直さない
  await page.getByTestId("modality-CT").click();
  await expect(rows(page).first()).toBeVisible();
  // モダリティと検査の記述のセル（段 3 で状態の列を外し、2026-10-20 に生年月日を3つの列に分け、2026-10-21 に受付番号の列を足したので 9 番目）
  const cell = rows(page).first().locator("td").nth(8);
  await expect(cell).toHaveAttribute("title", new RegExp(long));
  expect(await cell.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
  expect(await cell.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  // 切っても行は 1 行（28px）のまま
  expect((await rows(page).first().boundingBox())!.height).toBeLessThanOrEqual(30);
  // 詳細のパネルでは切らない（折り返す）
  await rows(page).first().click();
  const head = page.getByTestId("detail-head");
  await expect(head).toBeVisible();
  for (const sel of ["[data-testid=detail-name]", "p"]) {
    expect(await head.locator(sel).first().evaluate((el) => getComputedStyle(el).textOverflow)).not.toBe("ellipsis");
  }
});

test("絞り込みは 1 行の並び：検査日・モダリティに件数を添える。件数は押したあとの一覧の件数と合う", async ({ page }) => {
  await asRole(page, "一般");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  // 並びは高さ 28px のボタン（24px 以上）
  for (const id of ["date-today", "modality-CT", "filter-more"]) {
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(24);
  }
  // 見出しの名前は docs/spec.md の 2.2（全期間→すべて）
  await expect(page.getByTestId("date-all")).toHaveText("すべて (8)");
  await expect(page.getByTestId("modality-all")).toHaveText("すべて (8)");
  await expect(page.getByTestId("modality-CT")).toHaveText("CT (6)");
  await expect(page.getByTestId("modality-MR")).toHaveText("MR (2)");
  // 全部の見出しの件数が、押したあとの件数の見出しと、行の数に合う
  for (const id of ["date-today", "date-yesterday", "date-week", "date-month", "modality-CT", "modality-MR", "modality-US"]) {
    const n = await count(page.getByTestId(id));
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => headCount(page)).toBe(n);
    if (n === 0) await expect(page.getByText("該当する検査はありません")).toBeVisible();
    else await expect(rows(page)).toHaveCount(n);
    await page.getByTestId(id.startsWith("date-") ? "date-all" : "modality-all").click();
    await expect.poll(() => headCount(page)).toBe(8);
  }
});

test("件数は、ほかの見出しと検索を当てたあとの数になる（モダリティを選ぶと検査日の件数が変わる）", async ({ page }) => {
  await asRole(page, "一般");
  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect.poll(() => count(page.getByTestId("date-all"))).toBe(2);
  // 検査日を押したあとの件数は、押す前の見出しの件数と同じ
  const n = await count(page.getByTestId("date-week"));
  await page.getByTestId("date-week").click();
  await listSettled(page);
  await expect.poll(() => headCount(page)).toBe(n);
  // モダリティの見出しは、検査日を当てた数
  const ct = await count(page.getByTestId("modality-CT"));
  await page.getByTestId("modality-CT").click();
  await listSettled(page);
  await expect.poll(() => headCount(page)).toBe(ct);
  // 横断の検索を当てると、全部の見出しの件数が絞られる
  await page.getByTestId("modality-all").click();
  await page.getByTestId("date-all").click();
  await page.getByTestId("study-search").fill("JP-TEST-0004");
  await expect(page).toHaveURL(/q=JP-TEST-0004/);
  await listSettled(page);
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect.poll(() => count(page.getByTestId("date-all"))).toBe(2);
  await expect.poll(() => count(page.getByTestId("modality-all"))).toBe(2);
});

test("件数は役割を替えても、その役割の許可の一覧の中だけで数える（どの役割でも、見出しの合計は一覧と合う）", async ({ page }) => {
  for (const role of ["管理者", "一般"] as const) {
    await asRole(page, role);
    await page.goto("/");
    await expect(page.getByTestId("study-count")).toHaveText("8");
    expect(await count(page.getByTestId("date-all"))).toBe(8);
    expect(await count(page.getByTestId("modality-all"))).toBe(8);
    // モダリティの件数の合計は、複数のモダリティの検査の分だけ一覧より多くなりうるが、少なくはならない
    let sum = 0;
    for (const m of ["CT", "MR", "CR/DX", "US", "ES", "MG", "DOC", "SR"]) sum += await count(page.getByTestId(`modality-${m}`));
    expect(sum).toBeGreaterThanOrEqual(8);
  }
});

test("許されない項目の件数は出ない：画面の API の応答から見出しの件数が無ければ、画面も件数を出さない", async ({ page }) => {
  // 許可の一覧を狭めた役割の応答（モダリティの件数が無い。BFF の側は tests/unit/studies-route.test.ts で確かめる）
  await page.route("**/api/studies?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { facets: Record<string, unknown> };
    delete body.facets.modality;
    await route.fulfill({ response: res, json: body });
  });
  await asRole(page, "一般");
  await page.getByTestId("date-week").click();
  await expect(page.getByTestId("date-week")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("date-all")).toHaveText(/すべて \(\d+\)/);
  await expect(page.getByTestId("modality-CT")).toHaveText("CT");
  await expect(page.getByTestId("modality-all")).toHaveText("すべて");
  // 見出しの文字に、件数の括弧が出ていない
  expect(await page.getByTestId("study-filters").locator("[data-testid^=modality-]").allInnerTexts()).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/\(\d+\)/)]),
  );
});

test("上限に届いて数えきれない件数は「以上」と出す（確定の数のように出さない）", async ({ page }) => {
  // 1000 件を超える応答の形（モックの検査は 8 件なので、応答の atLeast だけを付ける。BFF の側は tests/unit/study-list-limit.test.ts）
  await page.route("**/api/studies?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { facets: Record<string, unknown> };
    body.facets.atLeast = { date: ["all"], list: true };
    await route.fulfill({ response: res, json: body });
  });
  await asRole(page, "一般");
  await page.getByTestId("date-week").click();
  await expect(page.getByTestId("date-week")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("date-all")).toHaveText(/すべて \(\d+ 以上\)/);
  await expect(page.getByTestId("date-today")).toHaveText(/今日 \(\d+\)/);
  await expect(page.getByTestId("modality-CT")).toHaveText(/CT \(\d+ 以上\)/);
});

test("「詳しく」：期間の指定は、押したときだけ出る。開け閉めでき、期間で絞っているときは最初から開く", async ({ page }) => {
  await asRole(page, "一般");
  const more = page.getByTestId("filter-more");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("filter-more-panel")).toHaveCount(0);
  await expect(page.getByTestId("date-range")).toHaveCount(0);
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("filter-more-panel")).toBeVisible();
  await page.getByTestId("date-range").click();
  await expect(page).toHaveURL(/date=range/);
  // 欄の名前は docs/spec.md の 2.2（期間の始まり・終わり→開始日・終了日）
  await expect(page.getByLabel("開始日")).toBeVisible();
  await page.getByLabel("開始日").fill("2026-10-17");
  await page.getByLabel("終了日").fill("2026-10-17");
  await expect(page.getByTestId("study-count")).toHaveText("4");
  await more.click();
  await expect(page.getByTestId("filter-more-panel")).toHaveCount(0);
  // 開き直すと、期間で絞っているので最初から開いている
  await page.reload();
  await expect(page.getByTestId("filter-more")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("date-range")).toHaveAttribute("aria-pressed", "true");
});

// 検査名は、モックの見本（QIDO-RS の写し）に値が無いので、単体の試験（tests/unit/study-advanced-filter.test.ts）と結合の試験で見る
test("詳細条件：生年月日・性別・受付番号で絞る。絞った値は一覧の列に見える。URL に残り、閉じても絞っている数が見え、条件をクリアで戻る", async ({ page }) => {
  await asRole(page, "一般");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  const more = page.getByTestId("filter-more");
  await more.click();
  const panel = page.getByTestId("filter-more-panel");

  // 生年月日（一致）
  await panel.getByLabel("生年月日").fill("1975-05-10");
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect(page).toHaveURL(/birth=1975-05-10/);
  for (const id of await rows(page).getByTestId("patient-id").allTextContents()) expect(id).toBe("JP-TEST-0001");
  // 絞った生年月日は、一覧の生年月日の列に見える
  for (const b of await rows(page).getByTestId("patient-birth").allTextContents()) expect(b).toBe("1975/05/10");
  await expect(page.getByTestId("filter-more-count")).toHaveText("（1）");

  // 性別を足す（どちらも当てる）
  await panel.getByTestId("filter-sex").selectOption({ label: "女" });
  await expect(page.getByTestId("study-count")).toHaveText("0");
  await panel.getByTestId("filter-sex").selectOption({ label: "男" });
  await expect(page.getByTestId("study-count")).toHaveText("2");
  for (const s of await rows(page).getByTestId("patient-sex").allTextContents()) expect(s).toBe("男");
  await expect(page.getByTestId("filter-more-count")).toHaveText("（2）");
  // 閉じても、絞っている数が見える
  await more.click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("filter-more-count")).toHaveText("（2）");
  await more.click();

  // 受付番号（含むもの）。ワイルドカードの字は打っても入らない
  await panel.getByLabel("生年月日").fill("");
  await panel.getByTestId("filter-sex").selectOption({ label: "すべて" });
  await panel.getByTestId("filter-accession").fill("0004*");
  await expect(panel.getByTestId("filter-accession")).toHaveValue("0004");
  // 打ってすぐ（300 ミリ秒の内に）閉じても、打った字は失わずに絞る
  await more.click();
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect(page).toHaveURL(/accession=0004/);
  await more.click();
  await expect(panel.getByTestId("filter-accession")).toHaveValue("0004");
  // 絞った受付番号は、一覧の受付番号の列に見える
  for (const a of await rows(page).getByTestId("accession-number").allTextContents()) expect(a).toContain("0004");
  // 紹介医の条件は持たない（2026-10-21 に承認者が外した）
  await expect(panel.getByTestId("filter-referring")).toHaveCount(0);
  await panel.getByTestId("filter-accession").fill("該当しない");
  await expect(page.getByTestId("study-count")).toHaveText("0");

  // 開き直しても同じ条件で、詳細条件は開いている。条件をクリアで、すべての検査に戻る
  await page.reload();
  await expect(page.getByTestId("filter-more")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("filter-accession")).toHaveValue("該当しない");
  await expect(page.getByTestId("study-count")).toHaveText("0");
  await page.getByRole("button", { name: "条件をクリア" }).click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("filter-more-count")).toHaveCount(0);
});

test("狭い画面では絞り込みが折り返し、横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await asRole(page, "一般");
  const g = await page.evaluate(() => {
    const f = document.querySelector("[data-testid=study-filters]")!;
    return { scroll: f.scrollWidth, client: f.clientWidth, page: document.documentElement.scrollWidth <= window.innerWidth };
  });
  expect(g.scroll).toBeLessThanOrEqual(g.client + 1);
  expect(g.page).toBe(true);
});

// 期待の変更（#57）：下の「UID」のボタン（開け閉め）をやめ、StudyInstanceUID は見出しの 3 行目、SeriesInstanceUID は画像の場所の見出しに、
// 写すボタンつきで常に出す。前は開け閉めの覚え（この端末のブラウザ）を確かめていたが、開け閉めが無くなったので、置き場と写すボタンを確かめる
test("詳細の UID：検査は見出しの 3 行目、シリーズは画像の場所の見出しに、写すボタンつきで常に出る。下のボタンは無い", async ({ page }) => {
  await asRole(page, "一般");
  await rows(page).first().click();
  const detail = page.getByTestId("study-detail");
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  await expect(detail.getByTestId("detail-uid-toggle")).toHaveCount(0);
  await expect(detail.getByTestId("detail-uid")).toHaveCount(0);
  // 検査の UID：見出しの中に、0.75rem・等幅で、写すボタンつき
  const head = detail.getByTestId("detail-head");
  await expect(head.getByTestId("study-uid").locator("code")).toHaveCSS("font-size", "12px");
  await expect(head.getByRole("button", { name: "StudyInstanceUIDをコピー" })).toBeVisible();
  expect((await head.getByRole("button", { name: "StudyInstanceUIDをコピー" }).boundingBox())!.height).toBeGreaterThanOrEqual(24);
  // シリーズの UID：シリーズを押すと画像の場所の見出しに出る。別のシリーズに替えると、そのシリーズの UID に替わる
  await expect(detail.getByTestId("series-uid")).toHaveCount(0);
  const open = detail.getByTestId("series-open");
  // 合成の見本のシリーズの UID（画面の API の答え）と完全に一致する
  const shown = (await detail.getAttribute("data-study-uid"))!;
  const body = (await (await page.request.get(`/api/studies/${encodeURIComponent(shown)}`)).json()) as { series: { seriesInstanceUid: string }[] };
  const seriesUids = body.series.map((s) => s.seriesInstanceUid);
  expect(seriesUids.length).toBeGreaterThanOrEqual(2);
  await open.nth(0).click();
  const area = detail.getByTestId("series-images");
  await expect(area.getByTestId("series-uid").locator("code")).toHaveText(seriesUids[0]!);
  await expect(area.getByTestId("series-uid").locator("code")).toHaveCSS("font-size", "12px");
  await expect(area.getByTestId("series-uid").locator("code")).toHaveCSS("font-family", /mono|Mono|Courier/);
  await expect(area.getByRole("button", { name: "SeriesInstanceUIDをコピー" })).toBeVisible();
  await open.nth(1).click();
  await expect(detail.getByTestId("series-images").getByTestId("series-uid").locator("code")).toHaveText(seriesUids[1]!);
  // 行を替えると、画像の場所は閉じ、見出しの UID は選んだ検査のものに替わる
  await rows(page).nth(1).click();
  await expect(detail.getByTestId("series-images")).toHaveCount(0);
  await expect(detail.getByTestId("study-uid")).not.toContainText(shown);
});

test("詳細の「検査のタグ」：画像の一覧が読めなくても、検査のタグは見られる", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  await page.route("**/series/*/instances", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "読み込めません" }) }));
  await page.getByTestId("series-open").first().click();
  const area = page.getByTestId("series-images");
  await expect(area.getByRole("alert")).toBeVisible();
  await area.getByTestId("tag-set-study").click();
  await expect(area.getByTestId("all-values")).toContainText("0010,0020");
  await page.unroute("**/series/*/instances");
});

// 期待の変更（患者バナー）：英字氏名・和暦・紹介医・Study ID・シリーズ数と画像数は、見出し（バナー）に足さず「検査の情報」のタブに置く。
// 受付番号はバナーに常に出る（UX のレビューの H8 のうち、毎回見る値）
test("詳細：受付番号はバナーに常に出し、英字氏名・和暦・紹介医・Study ID・シリーズ数と画像数は「検査の情報」のタブに置く", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  const detail = page.getByTestId("study-detail");
  const head = detail.getByTestId("detail-head");
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  await expect(page.getByTestId("detail-uid")).toHaveCount(0);
  await expect(head.getByTestId("detail-accession")).toContainText("受付番号");
  // バナーには足さない
  for (const id of ["detail-referring", "detail-alphabetic", "detail-counts"]) await expect(head.getByTestId(id)).toHaveCount(0);
  // 「検査の情報」のタブ：最初はシリーズのタブが開いている。押すと、バナーに足さない値が出る
  const tabs = detail.getByRole("tablist", { name: "検査の内容" });
  await expect(tabs.getByRole("tab", { name: "シリーズ" })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByTestId("detail-info")).toBeHidden();
  await tabs.getByRole("tab", { name: "検査の情報" }).click();
  await expect(tabs.getByRole("tab", { name: "検査の情報" })).toHaveAttribute("aria-selected", "true");
  const info = detail.getByTestId("detail-info");
  await expect(info).toBeVisible();
  await expect(detail.getByTestId("series-strip")).toBeHidden();
  await expect(info.getByTestId("detail-referring")).toHaveText(/紹介医\s*試験 医師/);
  await expect(info.getByTestId("detail-alphabetic")).toContainText("Shiken Takako");
  await expect(info).toContainText("1960/07/15（昭和35年）");
  await expect(info.getByTestId("detail-counts")).toHaveText(/シリーズ \/ 画像\s*1 \/ 4/);
  // 左右の矢印のキーでタブを移す。シリーズに戻ると、サムネイルがまた出る
  await tabs.getByRole("tab", { name: "検査の情報" }).press("ArrowLeft");
  await expect(tabs.getByRole("tab", { name: "シリーズ" })).toHaveAttribute("aria-selected", "true");
  await expect(detail.getByTestId("series-strip")).toBeVisible();
  // 押せる物の無い「検査の情報」も、Tab キーでフォーカスを受ける（キーボードで読み・スクロールできる）。見えていないパネルには移らない
  await tabs.getByRole("tab", { name: "検査の情報" }).click();
  await page.keyboard.press("Tab");
  await expect(detail.getByRole("tabpanel", { name: "検査の情報" })).toBeFocused();
  await tabs.getByRole("tab", { name: "シリーズ" }).click();
  await expect(detail.getByRole("tabpanel", { name: "検査の情報", includeHidden: true })).toBeHidden();
  // 見出しは、バナー（氏名とかなの 2 行）と UID の 1 行に収まる
  expect(await head.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(BANNER_HEAD_MAX);
});

test("詳細の見出し：受付番号が無いときも「受付番号 —」を出す（無いこと自体が照合の手がかり）", async ({ page }) => {
  await page.route("**/api/studies/*", async (route) => {
    // 一覧の版（自動更新の /api/studies/version）は検査の詳細ではないので、そのまま通す
    if (route.request().method() !== "GET" || route.request().url().endsWith("/api/studies/version")) return route.continue();
    const res = await route.fetch();
    const body = (await res.json()) as { study: Record<string, unknown> };
    body.study.accessionNumber = "";
    body.study.referringPhysicianName = "";
    await route.fulfill({ response: res, json: body });
  });
  await asRole(page, "一般");
  await page.route("**/api/studies?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { studies: Record<string, unknown>[] };
    for (const s of body.studies) {
      s.accessionNumber = "";
      s.referringPhysicianName = "";
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.getByTestId("modality-CT").click();
  await rows(page).first().click();
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  const head = page.getByTestId("detail-head");
  await expect(head.getByTestId("detail-accession")).toHaveText(/受付番号\s*—/);
  // ほかの値の無い項目は、項目ごと省く（「検査の情報」にも出ない）
  await expect(page.getByTestId("study-detail").getByTestId("detail-referring")).toHaveCount(0);
});

test("詳細の見出しは患者バナー：氏名・かな・患者 ID・生年月日と年齢・性別・検査日・モダリティ・検査名が、2 行（氏名とかな）に収まる", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await asRole(page, "一般");
  await page.locator("tr[data-study-uid]").filter({ hasText: "2 / 6" }).first().click();
  const head = page.getByTestId("detail-head");
  await expect(head).toContainText("JP-TEST-0004");
  const banner = head.getByRole("region", { name: "患者" });
  // 1280px の幅では、バナーの項目は氏名と同じ段に並ぶ（氏名 24px＋かな 18px＋内側の余白 16px 程度）
  expect((await banner.boundingBox())!.height).toBeLessThanOrEqual(64);
  // 下のシリーズのサムネイルが、同じ画面に見えている（詳細の場所の中。スクロールしなくても）
  const pane = (await page.getByTestId("detail-pane").boundingBox())!;
  const strip = (await page.getByTestId("series-strip").boundingBox())!;
  expect(strip.y + Math.min(strip.height, 80)).toBeLessThanOrEqual(pane.y + pane.height);
});

// 期待の変更（#57）：下の「DICOM タグ」のボタン（開け閉め）をやめ、検査単位の要約は画像の場所の「検査のタグ」から見る。
// ボタンの位置が動かないことの確かめは、切り替えの並び（主なタグ・すべてのタグ・検査のタグ）が動かないことに移した
test("詳細の「検査のタグ」：画像の場所の切り替えから見る。切り替えても並びの位置は動かない。検査単位（要約）だけを出す", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  await expect(page.getByTestId("detail-tags-toggle")).toHaveCount(0);
  await expect(page.getByTestId("dicom-tags")).toHaveCount(0);
  await page.getByTestId("series-open").first().click();
  const area = page.getByTestId("series-images");
  await expect(area.getByTestId("tag-set-configured")).toHaveAttribute("aria-pressed", "true");
  const place = (testId: string) =>
    page.getByTestId(testId).evaluate((el) => {
      // 詳細の場所はスクロールするので、画像の場所の頭からの位置で比べる
      const r = el.getBoundingClientRect();
      const top = el.closest("[data-testid=series-images]")!.getBoundingClientRect();
      return { x: r.left - top.left, y: r.top - top.top };
    });
  const before = await place("tag-set-study");
  await area.getByTestId("tag-set-study").click();
  await expect(area.getByTestId("tag-set-study")).toHaveAttribute("aria-pressed", "true");
  expect(await place("tag-set-study")).toEqual(before);

  // 中身は検査単位（要約）だけ。画像単位の表と、画像の SOPInstanceUID は出さない
  const tags = area.getByTestId("dicom-tags");
  await expect(tags).toContainText("検査単位（要約）");
  await expect(tags.getByTestId("all-values")).toContainText("0010,0020");
  await expect(tags.getByRole("button")).toHaveCount(0);
  await expect(area.getByTestId("instance-tags")).toHaveCount(0);
  await expect(area.getByTestId("instance-values")).toHaveCount(0);
  await expect(area.getByTestId("uid-line")).toHaveCount(0);

  // 主なタグに戻すと、画像単位の表に戻り、切り替えの位置は動かない
  await area.getByTestId("tag-set-configured").click();
  await expect(tags).toHaveCount(0);
  await expect(area.getByTestId("instance-tags")).toBeVisible();
  expect(await place("tag-set-study")).toEqual(before);
});

// 移した試験：前は「DICOM タグ」の画像単位で、シリーズと画像を選ぶ欄から確かめていた（2026-10-21）。
// 画像ごとの値はサムネイルから開く画像の場所へまとめた（change series-instance-tags）ので、同じ確かめ（画像を替えると値が替わり、
// 前の値が残らず、戻しても読み直す）を、サムネイルから開く流れで行う
test("サムネイルを押すと、下に画像の場所を開く：画像の一覧（番号の順）と、選んだ画像の SOPInstanceUID・主なタグ（タグ名つき）。画像を替えると値が替わる", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  const strip = page.getByTestId("series-strip");
  await expect(strip).toHaveAttribute("data-loaded", "true");
  await expect(page.getByTestId("series-images")).toHaveCount(0);
  const thumb = strip.getByTestId("series-open");
  await expect(thumb).toHaveAttribute("aria-pressed", "false");

  const tagReads: string[] = [];
  page.on("request", (req) => {
    if (/\/instances\/[\d.]+\/tags$/.test(req.url())) tagReads.push(req.url());
  });
  await thumb.click();
  await expect(thumb).toHaveAttribute("aria-pressed", "true");
  const area = page.getByTestId("series-images");
  await expect(area).toContainText("#1 Chest Axial 5mm");
  // 画像の一覧：画像の番号の順。最初は先頭を選ぶ
  const list = area.getByTestId("instance-list");
  await expect(list.getByRole("option")).toHaveText(["#1", "#2", "#3", "#4"]);
  await expect(list.getByRole("option", { name: "#1" })).toHaveAttribute("aria-selected", "true");
  // 既定は「主なタグ」：既定の 25 のタグを、タグ・タグ名・VR・値で出す
  await expect(area.getByTestId("tag-set-configured")).toHaveAttribute("aria-pressed", "true");
  const table = area.getByTestId("instance-tags");
  const sopLine = area.getByTestId("uid-line");
  await expect(sopLine).toContainText("SOPInstanceUID");
  const first = (await sopLine.locator("code").textContent())!;
  await expect(table.locator("tbody tr")).toHaveCount(25);
  await expect(table.locator("thead")).toHaveText(/タグ\s*タグ名\s*VR\s*値/);
  await expect(table.locator('tr[data-tag="0008,0018"]')).toContainText(`SOPインスタンスUID`);
  await expect(table.locator('tr[data-tag="0008,0018"]')).toContainText(first);
  await expect(table.locator('tr[data-tag="0020,0013"]')).toContainText("画像番号");
  await expect(table.locator('tr[data-tag="0028,0010"]')).toContainText("行数");
  // 画像に無いタグも行を出し、値は「—」
  await expect(table.locator('tr[data-tag="0018,0050"] [data-testid=tag-value]')).toHaveText("—");
  // 設定に無いタグ（患者の値）は出ない
  await expect(table.locator('tr[data-tag="0010,0020"]')).toHaveCount(0);

  // 画像を替えると、その画像の値に替わる（画像ごとに値が違う）
  await list.getByRole("option", { name: "#2" }).click();
  await expect(sopLine.locator("code")).not.toHaveText(first);
  const second = (await sopLine.locator("code").textContent())!;
  await expect(table.locator('tr[data-tag="0008,0018"]')).toContainText(second);
  await expect(table).not.toContainText(first);
  // 前の画像に戻しても、覚えた中身を出さずに読み直す（読むたびに権限の確かめと操作ログを通す）
  await list.getByRole("option", { name: "#1" }).click();
  await expect(table.locator('tr[data-tag="0008,0018"]')).toContainText(first);
  expect(tagReads.filter((u) => u.includes(`/instances/${first}/tags`))).toHaveLength(2);
  expect(tagReads.filter((u) => u.includes(`/instances/${second}/tags`))).toHaveLength(1);

  // 同じサムネイルをもう一度押すと閉じる
  await thumb.click();
  await expect(thumb).toHaveAttribute("aria-pressed", "false");
  await expect(area).toHaveCount(0);
});

test("画像の場所：上下の矢印のキーで画像を替える（検査一覧の行は動かない）。「すべてのタグ」は値の全部で、画像を替えても保つ", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  await page.getByTestId("series-open").click();
  const area = page.getByTestId("series-images");
  const list = area.getByTestId("instance-list");
  await expect(list.getByRole("option")).toHaveCount(4);
  await expect(area.getByTestId("instance-tags").locator("tbody tr")).toHaveCount(25);
  const first = (await area.getByTestId("uid-line").locator("code").textContent())!;
  // キーで通り過ぎた画像の値は読まない（読むたびに操作ログに残る）。止まった画像だけを 0.3 秒後に読む
  const tagReads: string[] = [];
  page.on("request", (req) => {
    if (/\/instances\/[\d.]+\/tags$/.test(req.url())) tagReads.push(req.url());
  });
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { name: "#2" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await expect(list.getByRole("option", { name: "#2" })).toHaveAttribute("aria-selected", "true");
  await expect(list).toBeFocused();
  const second = (await area.getByTestId("uid-line").locator("code").textContent())!;
  expect(second).not.toBe(first);
  await expect(area.getByTestId("instance-tags").locator('tr[data-tag="0008,0018"]')).toContainText(second);
  expect(tagReads).toHaveLength(1);
  expect(tagReads[0]).toContain(`/instances/${second}/tags`);
  // 検査一覧で選んだ行は替わらない
  await expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", STUDY);

  // すべてのタグ：その画像の値の全部（患者の値も）。タグ名の分かるものは日本語で出す
  await area.getByTestId("tag-set-all").click();
  await expect(area.getByTestId("tag-set-all")).toHaveAttribute("aria-pressed", "true");
  const all = area.getByTestId("instance-values");
  await expect(all.locator('tr[data-tag="0010,0020"]')).toContainText("患者ID");
  await expect(all.locator('tr[data-tag="0010,0020"]')).toContainText("JP-TEST-0004");
  // 日本語の値（ISO_IR 192 の見本）は崩れない
  await expect(all.locator('tr[data-tag="0010,0010"]')).toContainText("Shiken^Takako=試験^髙子=しけん^たかこ");
  // 画像を替えても「すべてのタグ」のまま
  await list.getByRole("option", { name: "#1" }).click();
  await expect(area.getByTestId("tag-set-all")).toHaveAttribute("aria-pressed", "true");
  await expect(all.locator('tr[data-tag="0020,0013"] [data-testid=tag-value]')).toHaveText("1");
  await area.getByTestId("tag-set-configured").click();
  await expect(area.getByTestId("instance-tags").locator("tbody tr")).toHaveCount(25);
});

test("画像の場所の値：HTML の形の値は文字のまま。長い値は 1024 文字で切り、全体の文字数を添える。バイナリは中身を出さない", async ({ page }) => {
  await asRole(page, "一般");
  await row(page).click();
  await page.getByTestId("series-open").click();
  const area = page.getByTestId("series-images");
  await area.getByTestId("tag-set-all").click();
  const all = area.getByTestId("instance-values");
  await area.getByTestId("instance-list").getByRole("option", { name: "#3" }).click();
  const comments = all.locator('tr[data-tag="0020,4000"] [data-testid=tag-value]');
  await expect(comments).toHaveText("<b>x</b>");
  await expect(comments.locator("b")).toHaveCount(0);
  await expect(all.locator('tr[data-tag="7FE0,0010"] [data-testid=tag-value]')).toHaveText("（バイナリ）");
  await expect(all.locator('tr[data-tag="7FE0,0010"]')).toContainText("画素データ");
  await area.getByTestId("instance-list").getByRole("option", { name: "#4" }).click();
  await expect(comments).toContainText("…（全 4,500 文字）");
  // 1024 文字と、後ろの添え書き
  expect(((await comments.textContent()) ?? "").replace(/…（全 4,500 文字）$/, "")).toHaveLength(1024);
});

test("画像の場所：別のサムネイルを押すと、そのシリーズに替わる。Enter でも開く。行を替えると閉じる", async ({ page }) => {
  await asRole(page, "一般");
  // シリーズが 2 つの検査（一覧の「2 / 6」の行）
  const twoSeries = page.locator("tr[data-study-uid]").filter({ hasText: "2 / 6" }).first();
  await twoSeries.click();
  const thumbs = page.getByTestId("series-strip").getByTestId("series-open");
  await expect(thumbs).toHaveCount(2);
  await thumbs.nth(1).click();
  const area = page.getByTestId("series-images");
  const secondSeries = await area.getAttribute("data-series-uid");
  await expect(thumbs.nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(area.getByTestId("instance-list").getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await thumbs.nth(0).focus();
  await page.keyboard.press("Enter");
  await expect(thumbs.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(thumbs.nth(1)).toHaveAttribute("aria-pressed", "false");
  await expect(area).not.toHaveAttribute("data-series-uid", secondSeries!);
  await page.keyboard.press(" ");
  await expect(area).toHaveCount(0);
  await page.keyboard.press(" ");
  await expect(page.getByTestId("series-images")).toHaveCount(1);
  // 別の行を選ぶと閉じる
  await row(page).click();
  await expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", STUDY);
  await expect(page.getByTestId("series-images")).toHaveCount(0);
});

test("画像の場所：狭い幅（600px）では、画像の一覧を上、タグの表を下に重ね、横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await asRole(page, "一般");
  await row(page).click({ position: { x: 100, y: 12 } });
  await page.getByTestId("series-open").click();
  const area = page.getByTestId("series-images");
  const list = (await area.getByTestId("instance-list").boundingBox())!;
  const table = (await area.getByTestId("instance-tags").boundingBox())!;
  expect(table.y).toBeGreaterThanOrEqual(list.y + list.height);
  const box = (await area.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(600);
});

test("自動更新：30 秒ごとに一覧の版を読み、変わったときだけ一覧を読み直す。選んだ行・スクロール・開いている詳細は残る", async ({ page }) => {
  // 一覧がスクロールする高さにする
  await page.setViewportSize({ width: 1280, height: 520 });
  await asRole(page, "一般");
  // 役割を選ぶために開いた頁の版の要求が、この下で足す route に入って数えられないよう、その頁を閉じてから始める
  // （混んだ CI では、その頁の最初の要求が遅れて出る）
  await page.goto("about:blank");
  const real = (await (await page.request.get("/api/studies/version")).json()) as { version: string };
  let version = Number(real.version);
  let versionStatus = 200;
  let versionReads = 0;
  await page.route("**/api/studies/version", (route) => {
    versionReads += 1;
    return versionStatus === 200
      ? route.fulfill({ json: { version: String(version) } })
      : route.fulfill({ status: versionStatus, json: { error: "画像サーバーに接続できません" } });
  });
  // 版が変わった後の一覧には、新しく届いた検査（合成）を先頭に足す
  const NEW_UID = "1.2.826.0.1.3680043.8.498.999999999";
  let arrived = false;
  let listReads = 0;
  // 一覧の答えを止めておく（読み直しの途中の画面を確かめるため）
  let hold: Promise<void> | null = null;
  let release = () => {};
  const listUrls: string[] = [];
  await page.route(/\/api\/studies(\?[^/]*)?$/, async (route) => {
    listReads += 1;
    listUrls.push(route.request().url());
    if (hold) await hold;
    const res = await route.fetch();
    const body = await res.json();
    if (arrived) {
      body.studies.unshift({ ...body.studies[0], studyInstanceUid: NEW_UID, patientId: "JP-TEST-NEW", studyDate: "20261021" });
      body.count.count += 1;
    }
    await route.fulfill({ response: res, json: body });
  });
  await page.clock.install();
  await page.goto("/");
  await expect(rows(page)).toHaveCount(8);
  await expect(page.getByTestId("list-refresh")).toHaveText("自動更新（30秒）");
  // 開いたときに版を 1 回読む（サーバーが一覧を取る前に読んだ版と同じなので、一覧は読み直さない）
  await expect.poll(() => versionReads).toBe(1);
  expect(listReads).toBe(0);

  // 一覧をいちばん下までスクロールし、最後の行を選んで詳細を開く
  const list = page.getByTestId("study-list-scroll");
  await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
  const target = rows(page).last();
  const uid = (await target.getAttribute("data-study-uid"))!;
  await target.click();
  await expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", uid);
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  const scrolled = await list.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  const rowTop = (await target.boundingBox())!.y;

  // 30 秒たつと版を読む。版が変わらなければ、一覧は読み直さない（検索も監査の記録も増やさない）
  await page.clock.fastForward(30_000);
  await expect.poll(() => versionReads).toBe(2);
  expect(listReads).toBe(0);

  // 版が変わると一覧を読み直し、新しい検査が先頭に出る。選んだ行・詳細・見ていた行の位置はそのまま
  version += 1;
  arrived = true;
  hold = new Promise<void>((resolve) => (release = resolve));
  await page.clock.fastForward(30_000);
  await expect.poll(() => listReads).toBe(1);
  // 読み直しの途中（待ちの印を出す 0.3 秒を過ぎても）：細い帯・薄い行・件数の「—」を出さない
  await page.clock.runFor(1_000);
  await expect(page.locator("tbody[data-dim]")).toHaveCount(0);
  await expect(page.getByTestId("progress-bar")).toHaveCount(0);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("pending-text")).toHaveCount(0);
  hold = null;
  release();
  await expect(rows(page)).toHaveCount(9);
  expect(listReads).toBe(1);
  // 自動更新の読み直しには refresh=auto を付ける（監査の記録に trigger: "auto" が残る）
  expect(new URL(listUrls[0]!).searchParams.get("refresh")).toBe("auto");
  await expect(rows(page).first()).toHaveAttribute("data-study-uid", NEW_UID);
  await expect(page.getByTestId("study-count")).toHaveText("9");
  await expect(page.locator(`tr[data-study-uid="${uid}"]`)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", uid);
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  expect(Math.abs((await page.locator(`tr[data-study-uid="${uid}"]`).boundingBox())!.y - rowTop)).toBeLessThanOrEqual(2);
  // 自動更新の読み直しでは、古い行を薄くしない
  await expect(page.locator("tbody[data-dim]")).toHaveCount(0);

  // 版を読めなければ、自動更新が止まっていることを出す。読めるようになれば戻る
  versionStatus = 502;
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId("list-refresh")).toHaveText("自動更新：接続できません");
  versionStatus = 200;
  await page.clock.fastForward(30_000);
  await expect(page.getByTestId("list-refresh")).toHaveText("自動更新（30秒）");

  // タブを隠している間は版を読まない。戻すとすぐ読む
  const setVisibility = (state: "hidden" | "visible") =>
    page.evaluate((s) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => s });
      document.dispatchEvent(new Event("visibilitychange", { bubbles: true }));
    }, state);
  await setVisibility("hidden");
  const hiddenFrom = versionReads;
  await page.clock.fastForward(90_000);
  expect(versionReads).toBe(hiddenFrom);
  await setVisibility("visible");
  await expect.poll(() => versionReads).toBeGreaterThan(hiddenFrom);

  // 利用者が絞り込みを替えた読み直しには、refresh=auto を付けない
  // 答えが返るまで待つ（差し替えの途中で試験を終えない）
  const ct = page.waitForResponse((r) => r.url().includes("/api/studies?") && r.url().includes("modality=CT"));
  await page.getByTestId("modality-CT").click();
  const res = await ct;
  expect(new URL(res.url()).searchParams.get("refresh")).toBeNull();
  await expect(page.getByTestId("modality-CT")).toHaveAttribute("aria-pressed", "true");
});
