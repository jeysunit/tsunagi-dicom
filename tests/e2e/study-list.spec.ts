import { expect, test, type Page } from "@playwright/test";

// 段 2 の検査の一覧（docs/spec.md の 3.1・3.2）：すぐ絞れる見出し・詳細のパネル・状態・ビューアの選び分けと記憶。
// 検証モード（AUTH_MODE=dev）とモックのバックエンドに対して流す。状態は試験のデータベースに残るので、
// 変えた状態は同じ試験の中で戻し、順に流す。

test.describe.configure({ mode: "serial" });

/** サムネイルの写しがある検査（見本の 1 件目。JP-TEST-0004・2026-04-10・CT） */
const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

async function asRole(page: Page, label: "管理者" | "医師" | "技師" | "閲覧") {
  await page.goto("/");
  const band = page.getByTestId("dev-mode-band");
  const button = band.getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

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
  await asRole(page, "医師");
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
  await expect(page.getByText("合う検査が無い")).toBeVisible();
});

// 期待の変更（1 件）：一覧の行のサムネイル（写しのある検査は画像・無い検査は印）の確かめを外した。
// 1 行 28px の一覧ではサムネイルの列を外したため（docs/spec.md の 3.1）。サムネイルは詳細のシリーズの横 1 列で確かめる（下の試験）。
test("一覧の行：氏名（漢字・かな）・和暦と年齢・シリーズ数と画像数", async ({ page }) => {
  await asRole(page, "医師");
  const r = row(page);
  await expect(r).toContainText("試験 髙子");
  await expect(r).toContainText("しけん たかこ");
  await expect(r).toContainText("1960/07/15（昭和35年・65歳・女）");
  await expect(r).toContainText("1 / 4");
  // 一覧の行にはサムネイルを出さない
  await expect(r.getByTestId("thumbnail")).toHaveCount(0);
  await expect(r.getByTestId("thumbnail-missing")).toHaveCount(0);
  // PN の元の形（^ と =）は画面に出さない
  expect(await page.locator("main").innerText()).not.toContain("^");
});

test("詳細のシリーズ：サムネイルが横に 1 列に並び、横にスクロールでき、まわりは暗い地", async ({ page }) => {
  await asRole(page, "医師");
  // シリーズが 2 つの検査（一覧の「2 / 6」の行）
  await page.locator("tr[data-study-uid]").filter({ hasText: "2 / 6" }).first().click();
  const strip = page.getByTestId("series-strip");
  await expect(strip.getByTestId("series-item")).toHaveCount(2);
  await expect(strip).toHaveCSS("background-color", "rgb(18, 20, 23)");
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
  await asRole(page, "医師");
  await page.locator("tr[data-study-uid]").filter({ hasText: "2 / 6" }).first().click({ position: { x: 100, y: 12 } });
  const row = page.getByTestId("series-row");
  await expect(row).toBeVisible();
  const boxes = await page.getByTestId("series-item").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(new Set(boxes.map((t) => Math.round(t))).size).toBe(1);
});

// 期待の変更（1 件）：検査と患者の情報の 2 列と UID は、詳細の「すべての項目」を押して開いてから確かめる。
// 見出しの 1〜2 行に詰め、ほかの値を「すべての項目」の中へ移したため（docs/spec.md の 3.1）。確かめる値は同じ。
test("詳細のパネル：行のクリックで開き、見出しの要点と、すべての項目（検査と患者の情報・UID）・シリーズの並び（暗い地）を出す", async ({ page }) => {
  await asRole(page, "医師");
  await row(page).click();
  const detail = page.getByTestId("study-detail");
  await expect(detail).toBeVisible();
  // 見出し（1〜2 行）：氏名・かな・患者 ID・生年月日と和暦・年齢・性別／検査日時・モダリティ・検査の記述
  const head = detail.getByTestId("detail-head");
  await expect(head).toContainText("試験 髙子");
  await expect(head).toContainText("しけん たかこ");
  await expect(head).toContainText("JP-TEST-0004");
  await expect(head).toContainText("1960/07/15（昭和35年・65歳・女）");
  await expect(head).toContainText("2026/04/10");
  await expect(head).toContainText("CT");
  expect(await head.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(2 * 24 + 4);
  // 閉じているうちは、ほかの値と UID は出ない
  const toggle = detail.getByTestId("detail-all-items-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(detail.getByTestId("detail-all-items")).toHaveCount(0);
  await expect(detail.getByTestId("uid-line")).toHaveCount(0);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(detail).toContainText("患者の情報");
  await expect(detail).toContainText("検査の情報");
  await expect(detail).toContainText("JP-TEST-0004");
  await expect(detail).toContainText("試験 医師");
  await expect(detail.getByTestId("uid-line").first()).toContainText(STUDY);
  const uid = detail.getByTestId("uid-line").first().locator("code");
  await expect(uid).toHaveCSS("font-size", "12px");
  await expect(uid).toHaveCSS("font-family", /mono|Mono|Courier/);
  const strip = detail.getByTestId("series-strip");
  await expect(strip.getByTestId("series-item")).toHaveCount(1);
  await expect(strip).toContainText("Chest Axial 5mm");
  await expect(strip).toHaveCSS("background-color", "rgb(18, 20, 23)");
  // 医師には「すべての DICOM の値」が無い
  await expect(detail.getByRole("button", { name: "すべての DICOM の値" })).toHaveCount(0);

  // もう一度押しても閉じない（下の詳細は選んだ行のものを出し続ける）。Escape で選びを外すと案内に戻る
  // （期待の変更：行の下に開く形をやめ、もう一度押して閉じる動きを、Escape に替えた。docs/spec.md の 3.1）
  await row(page).click();
  await expect(detail).toBeVisible();
  await row(page).focus();
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId("study-detail-empty")).toBeVisible();
});

// 詳細がどの検査のものか。UID の行は「すべての項目」の中（閉じている）なので、詳細の枠に付けた data-study-uid で確かめる
const expectDetail = (page: Page, uid: string) => expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", uid);

test("上下に分ける：行を選ぶと下の詳細が替わり、一覧の行は動かない。頁全体はスクロールしない", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await asRole(page, "医師");
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
  await asRole(page, "医師");
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
  await asRole(page, "医師");
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
  await asRole(page, "医師");
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
  await asRole(page, "医師");
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
  for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("tr[data-study-uid]"))).toBe(false);
  expect(await pane.evaluate((el) => el.contains(document.activeElement))).toBe(true);

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
  await page.setViewportSize({ width: 1280, height: 560 });
  await asRole(page, "医師");
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
  await expect(page.getByTestId("series-strip")).not.toContainText("読んでいる");

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
  await expect(page.getByTestId("series-strip")).toContainText("読んでいる");
  expect(gets).toEqual([]);

  // 止まれば取り直し、そのとき記録が1件分（k）増える。B は一度も取っていない
  await again;
  await expect(page.getByTestId("series-strip")).not.toContainText("読んでいる");
  expect(await recorded()).toBe(base + 2 * k);
  await page.waitForTimeout(600);
  expect(await recorded()).toBe(base + 2 * k);
  expect(gets).toEqual([uids[0]]);
});

test("状態を変えても、詳細は取り直さず、「詳細を開いた」の記録は増えない", async ({ page }) => {
  await asRole(page, "技師");
  const gets: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "GET" && /\/api\/studies\/[0-9.]+$/.test(new URL(req.url()).pathname)) gets.push(req.url());
  });
  await row(page).click();
  await expect(page.getByTestId("series-strip")).not.toContainText("読んでいる");
  expect(gets).toHaveLength(1);
  const inspected = page.getByTestId("state-inspected");
  const before = await inspected.getAttribute("aria-pressed");
  await inspected.click();
  await expect(inspected).not.toHaveAttribute("aria-pressed", before!);
  await page.waitForTimeout(500);
  expect(gets).toHaveLength(1);
  // 戻す
  await inspected.click();
  await expect(inspected).toHaveAttribute("aria-pressed", before!);
  expect(gets).toHaveLength(1);
});

test("応答の順が逆になっても、古い応答が新しい選びを上書きしない", async ({ page }) => {
  await asRole(page, "医師");
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
  await expect(page.getByTestId("series-strip")).not.toContainText("読んでいる");
  release();
  await page.waitForTimeout(500);
  await expectDetail(page, uids[1]!);
  await expect(page.getByTestId("study-detail")).not.toHaveAttribute("data-study-uid", uids[0]!);
  // 「すべての項目」を開いても、出ている UID は選んだ検査のものだけ
  await page.getByTestId("detail-all-items-toggle").click();
  await expect(page.getByTestId("detail-pane")).toContainText(uids[1]!);
  await expect(page.getByTestId("detail-pane")).not.toContainText(uids[0]!);
});

test("状態：技師が検像し、一覧の状態の見出しで絞れる。閲覧には検像のボタンが無い", async ({ page }) => {
  await asRole(page, "技師");
  await row(page).click();
  const inspected = page.getByTestId("state-inspected");
  await expect(inspected).toHaveText("未検像");
  await inspected.click();
  await expect(inspected).toHaveAttribute("aria-pressed", "true");
  await expect(inspected).toHaveText("検像済");
  await expect(row(page)).toContainText("検像済");
  // 技師には読影の状態のボタンが無く、すべての値は見られる
  await expect(page.getByTestId("state-read")).toHaveCount(0);
  await page.getByRole("button", { name: "すべての DICOM の値" }).click();
  await expect(page.getByTestId("all-values")).toContainText("0010,0020");

  await page.getByTestId("status-inspected").click();
  await expect(page.getByTestId("study-count")).toHaveText("1");

  await asRole(page, "閲覧");
  await page.goto("/");
  await row(page).click();
  await expect(page.getByTestId("study-detail")).toBeVisible();
  await expect(page.getByTestId("state-inspected")).toHaveCount(0);
  await expect(page.getByTestId("state-bookmarked")).toBeVisible();

  // 戻す
  await asRole(page, "技師");
  await page.goto("/");
  await row(page).click();
  await page.getByTestId("state-inspected").click();
  await expect(page.getByTestId("state-inspected")).toHaveText("未検像");
});

test("ビューア：▶ と、ダブルクリックで既定のビューアを別のタブで開き、開いたことを記録する", async ({ page }) => {
  await asRole(page, "管理者");
  const before = await (await page.request.get("/api/audit/verify")).json();

  await expectOpened(
    page,
    () => row(page).getByTestId("open-default").click(),
    `https://viewer.example.org/ohif/viewer?StudyInstanceUIDs=${STUDY}`,
  );
  await expectOpened(page, () => row(page).locator("td").nth(3).dblclick(), /viewer\.example\.org\/ohif\/viewer/);

  const after = await (await page.request.get("/api/audit/verify")).json();
  expect(after.ok).toBe(true);
  expect(after.checked).toBeGreaterThan(before.checked);
});

test("ビューア：▾ から「この検査は次から Stone」と覚え、行に既定を出し、覚えを消せる", async ({ page }) => {
  await asRole(page, "医師");
  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: "この検査は次から Stone" }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveText("既定: Stone");

  await expectOpened(
    page,
    () => row(page).getByTestId("open-default").click(),
    `https://viewer.example.org/stone/index.html?study=${STUDY}`,
  );

  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: /覚えを消す/ }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveCount(0);

  // 閲覧には覚えさせる項目が無い
  await asRole(page, "閲覧");
  await page.goto("/");
  await row(page).getByTestId("open-menu").click();
  await expect(page.getByRole("menuitem", { name: /この検査は次から/ })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /DICOMweb の URL をコピー/ })).toContainText("このアプリの監査の外");
});

test("モダリティごとの既定のビューア：管理者が管理の画面で変え、ほかの役割は開けない", async ({ page }) => {
  await asRole(page, "医師");
  await page.goto("/admin/viewers");
  await expect(page.getByText("管理者だけが開ける")).toBeVisible();

  await asRole(page, "管理者");
  await page.getByRole("navigation", { name: "頁" }).getByRole("link", { name: "ビューアの既定" }).click();
  await expect(page).toHaveURL(/\/admin\/viewers$/);
  const ct = page.getByLabel("CT の既定のビューア");
  await expect(ct).toHaveValue("ohif");
  await ct.selectOption("stone");
  await expect(page.getByText("CT の既定を変えた")).toBeVisible();

  await page.goto("/");
  await expectOpened(page, () => row(page).getByTestId("open-default").click(), /viewer\.example\.org\/stone\//);

  // 戻す
  await page.goto("/admin/viewers");
  await page.getByLabel("CT の既定のビューア").selectOption("ohif");
  await expect(page.getByText("CT の既定を変えた")).toBeVisible();
});

// ---- 1 行の一覧・件数つきの絞り込み・詰めた詳細（docs/spec.md の 3.1） ----

const count = async (loc: ReturnType<Page["getByTestId"]>) => Number(/\((\d+)\)/.exec(await loc.innerText())![1]);
const headCount = async (page: Page) => Number(await page.getByTestId("study-count").innerText());

test("1 行の一覧：行の高さは 28px（14px の文字）、氏名の漢字とかなは別の列（かなは右）", async ({ page }) => {
  await asRole(page, "医師");
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
  await expect(page.getByRole("columnheader", { name: "かな" })).toBeVisible();
});

test("1 行の一覧：1280×720 の画面で、見える行が前（2 行）より多い。ビューアの部品も 1 行に収まり、押せる大きさは 24px 以上", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await asRole(page, "医師");
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
  await page.getByRole("menuitem", { name: "この検査は次から Stone" }).click();
  await expect(row(page).getByTestId("remembered-viewer")).toHaveText("既定: Stone");
  expect((await row(page).boundingBox())!.height).toBeLessThanOrEqual(30);
  await row(page).getByTestId("open-menu").click();
  await page.getByRole("menuitem", { name: /覚えを消す/ }).click();
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
  await asRole(page, "医師");
  await page.getByTestId("date-all").click(); // 押し直しでは読み直さない
  await page.getByTestId("modality-CT").click();
  await expect(rows(page).first()).toBeVisible();
  const cell = rows(page).first().locator("td").nth(6);
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

test("絞り込みは 1 行の並び：検査日・モダリティ・状態に件数を添える。件数は押したあとの一覧の件数と合う", async ({ page }) => {
  await asRole(page, "医師");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  // 並びは高さ 28px のボタン（24px 以上）
  for (const id of ["date-today", "modality-CT", "status-unread", "filter-more"]) {
    expect((await page.getByTestId(id).boundingBox())!.height).toBeGreaterThanOrEqual(24);
  }
  await expect(page.getByTestId("date-all")).toHaveText("全期間 (8)");
  await expect(page.getByTestId("modality-all")).toHaveText("すべて (8)");
  await expect(page.getByTestId("status-all")).toHaveText("すべて (8)");
  await expect(page.getByTestId("modality-CT")).toHaveText("CT (6)");
  await expect(page.getByTestId("modality-MR")).toHaveText("MR (2)");
  // 全部の見出しの件数が、押したあとの件数の見出しと、行の数に合う
  for (const id of ["date-today", "date-yesterday", "date-week", "date-month", "modality-CT", "modality-MR", "modality-US", "status-uninspected", "status-unread", "status-urgent", "status-bookmarked"]) {
    const n = await count(page.getByTestId(id));
    await page.getByTestId(id).click();
    await expect(page.getByTestId(id)).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => headCount(page)).toBe(n);
    if (n === 0) await expect(page.getByText("合う検査が無い")).toBeVisible();
    else await expect(rows(page)).toHaveCount(n);
    await page.getByTestId(id.startsWith("date-") ? "date-all" : id.startsWith("modality-") ? "modality-all" : "status-all").click();
    await expect.poll(() => headCount(page)).toBe(8);
  }
});

test("件数は、ほかの見出しと検索を当てたあとの数になる（モダリティを選ぶと状態の件数が変わる）", async ({ page }) => {
  await asRole(page, "医師");
  await page.getByTestId("modality-MR").click();
  await expect(page.getByTestId("study-count")).toHaveText("2");
  // 状態の「すべて」は、いまの一覧の件数と同じ
  await expect.poll(() => count(page.getByTestId("status-all"))).toBe(2);
  await expect.poll(() => count(page.getByTestId("date-all"))).toBe(2);
  // 状態を押したあとの件数は、押す前の見出しの件数と同じ
  const n = await count(page.getByTestId("status-uninspected"));
  await page.getByTestId("status-uninspected").click();
  await expect.poll(() => headCount(page)).toBe(n);
  // モダリティの見出しは、状態を当てた数（MR 以外の CT は、この状態のぶん）
  const ct = await count(page.getByTestId("modality-CT"));
  await page.getByTestId("modality-CT").click();
  await expect.poll(() => headCount(page)).toBe(ct);
  // 横断の検索を当てると、全部の見出しの件数が絞られる
  await page.getByTestId("modality-all").click();
  await page.getByTestId("status-all").click();
  await page.getByTestId("study-search").fill("JP-TEST-0004");
  await expect(page.getByTestId("study-count")).toHaveText("2");
  await expect.poll(() => count(page.getByTestId("date-all"))).toBe(2);
  await expect.poll(() => count(page.getByTestId("modality-all"))).toBe(2);
});

test("件数は役割を替えても、その役割の許可の一覧の中だけで数える（どの役割でも、見出しの合計は一覧と合う）", async ({ page }) => {
  for (const role of ["管理者", "医師", "技師", "閲覧"] as const) {
    await asRole(page, role);
    await page.goto("/");
    await expect(page.getByTestId("study-count")).toHaveText("8");
    expect(await count(page.getByTestId("date-all"))).toBe(8);
    expect(await count(page.getByTestId("modality-all"))).toBe(8);
    expect(await count(page.getByTestId("status-all"))).toBe(8);
    // モダリティの件数の合計は、複数のモダリティの検査の分だけ一覧より多くなりうるが、少なくはならない
    let sum = 0;
    for (const m of ["CT", "MR", "CR/DX", "US", "ES", "MG", "DOC", "SR"]) sum += await count(page.getByTestId(`modality-${m}`));
    expect(sum).toBeGreaterThanOrEqual(8);
  }
});

test("許されない項目の件数は出ない：画面の API の応答から見出しの件数が無ければ、画面も件数を出さない", async ({ page }) => {
  // 許可の一覧を狭めた役割の応答（モダリティ・状態の件数が無い。BFF の側は tests/unit/studies-route.test.ts で確かめる）
  await page.route("**/api/studies?*", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { facets: Record<string, unknown> };
    delete body.facets.modality;
    delete body.facets.status;
    await route.fulfill({ response: res, json: body });
  });
  await asRole(page, "医師");
  await page.getByTestId("date-week").click();
  await expect(page.getByTestId("date-week")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("date-all")).toHaveText(/全期間 \(\d+\)/);
  await expect(page.getByTestId("modality-CT")).toHaveText("CT");
  await expect(page.getByTestId("modality-all")).toHaveText("すべて");
  await expect(page.getByTestId("status-unread")).toHaveText("未読");
  await expect(page.getByTestId("status-all")).toHaveText("すべて");
  // 見出しの文字に、件数の括弧が出ていない
  expect(await page.getByTestId("study-filters").locator("[data-testid^=modality-], [data-testid^=status-]").allInnerTexts()).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/\(\d+\)/)]),
  );
});

test("「詳しく」：期間の指定は、押したときだけ出る。開け閉めでき、期間で絞っているときは最初から開く", async ({ page }) => {
  await asRole(page, "医師");
  const more = page.getByTestId("filter-more");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("filter-more-panel")).toHaveCount(0);
  await expect(page.getByTestId("date-range")).toHaveCount(0);
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("filter-more-panel")).toBeVisible();
  await page.getByTestId("date-range").click();
  await expect(page).toHaveURL(/date=range/);
  await expect(page.getByLabel("期間の始まり")).toBeVisible();
  await page.getByLabel("期間の始まり").fill("2026-10-17");
  await page.getByLabel("期間の終わり").fill("2026-10-17");
  await expect(page.getByTestId("study-count")).toHaveText("4");
  await more.click();
  await expect(page.getByTestId("filter-more-panel")).toHaveCount(0);
  // 開き直すと、期間で絞っているので最初から開いている
  await page.reload();
  await expect(page.getByTestId("filter-more")).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("date-range")).toHaveAttribute("aria-pressed", "true");
});

test("狭い画面では絞り込みが折り返し、横にはみ出さない", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await asRole(page, "医師");
  const g = await page.evaluate(() => {
    const f = document.querySelector("[data-testid=study-filters]")!;
    return { scroll: f.scrollWidth, client: f.clientWidth, page: document.documentElement.scrollWidth <= window.innerWidth };
  });
  expect(g.scroll).toBeLessThanOrEqual(g.client + 1);
  expect(g.page).toBe(true);
});

test("詳細の「すべての項目」：初めは閉じ、押すと検査と患者の情報・UID が開く。開閉は行を替えても、開き直しても残る", async ({ page }) => {
  await asRole(page, "医師");
  await rows(page).first().click();
  const detail = page.getByTestId("study-detail");
  const toggle = detail.getByTestId("detail-all-items-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(detail.getByTestId("detail-all-items")).toHaveCount(0);
  // 閉じているうちも、見出しとシリーズは出ている
  await expect(detail.getByTestId("detail-head")).toBeVisible();
  await expect(page.getByTestId("series-strip")).not.toContainText("読んでいる");
  expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(24);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const all = detail.getByTestId("detail-all-items");
  await expect(all).toContainText("検査の情報");
  await expect(all).toContainText("患者の情報");
  await expect(all).toContainText("氏名（英字）");
  await expect(all.getByTestId("uid-line").first().locator("code")).toHaveCSS("font-size", "12px");
  // シリーズの UID も、この中に 0.75rem・等幅で出て、コピーのボタンがある
  // 1 行目の検査（シリーズが 2 つ）：StudyInstanceUID の 1 行と、SeriesInstanceUID の 2 行
  await expect(all.getByTestId("uid-line")).toHaveCount(3);
  await expect(all.getByRole("button", { name: /SeriesInstanceUID.*をコピー/ })).toHaveCount(2);

  // 行を替えても開いたまま。開き直しても開いたまま
  await rows(page).nth(1).click();
  await expect(page.getByTestId("detail-all-items-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await rows(page).first().click();
  await expect(page.getByTestId("detail-all-items-toggle")).toHaveAttribute("aria-expanded", "true");
  // 閉じると、それも残る
  await page.getByTestId("detail-all-items-toggle").click();
  await expect(page.getByTestId("detail-all-items")).toHaveCount(0);
  await page.reload();
  await rows(page).first().click();
  await expect(page.getByTestId("detail-all-items-toggle")).toHaveAttribute("aria-expanded", "false");
});

test("詳細の見出しは 1〜2 行：氏名・かな・患者 ID・生年月日と和暦・年齢・性別・検査日・モダリティ・検査の記述", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await asRole(page, "医師");
  await page.locator("tr[data-study-uid]").filter({ hasText: "2 / 6" }).first().click();
  const head = page.getByTestId("detail-head");
  await expect(head).toContainText("JP-TEST-0004");
  const lines = await head.locator("> p").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  expect(lines).toHaveLength(2);
  // 1 行ずつ（14px の文字の行の高さ 20px。1 行に収まる幅）
  for (const h of lines) expect(h).toBeLessThanOrEqual(24);
  // 下のシリーズのサムネイルが、同じ画面に見えている（詳細の場所の中。スクロールしなくても）
  const pane = (await page.getByTestId("detail-pane").boundingBox())!;
  const strip = (await page.getByTestId("series-strip").boundingBox())!;
  expect(strip.y + Math.min(strip.height, 80)).toBeLessThanOrEqual(pane.y + pane.height);
});
