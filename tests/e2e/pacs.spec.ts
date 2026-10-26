import { expect, test, type Page } from "@playwright/test";

// 段 4 の画面（docs/spec.md の 3.3・3.4）：受け取りの記録・機器の一覧と C-ECHO・送る。
// 検証モード（AUTH_MODE=dev）とモックの Orthanc に対して流す。この試験のサーバーは DEV_ALLOW_WRITE=false（既定）なので、
// 送る操作は止まることを確かめる。送るの一巡りは、AUTH_MODE=local のサーバー（tests/e2e/local-auth.spec.ts）で確かめる。

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
/** 受信一覧を、見本の受信の日（2026-10-17）の期間で開く（期間の初期設定は今日で、見本の受信は入らない） */
const RECEIVED_SAMPLE_DAY = "/received?period=range&from=2026-10-17&to=2026-10-17";

// 役割は管理者と一般の2つ（2026-10-20。docs/spec.md の 3.6）。前の技師で流していた試験は、一般で流す
async function asRole(page: Page, label: "管理者" | "一般") {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

// 期待の変更（文言）：画面の言葉を docs/spec.md の 2.2 の用語集に合わせた（受け取り→受信一覧・取り込み→インポート・
// 一覧で開く→検査一覧で表示・つながった→成功（時刻つき）・書き込みは止めている→書き込み：無効など）。確かめる振る舞いは同じ。
test("受け取りの記録：一般は、受け取った検査を新しい順に 1 件 1 行で見られ、REST で入った検査は「インポート」と分かる", async ({ page }) => {
  await asRole(page, "一般");
  await page.getByRole("navigation", { name: "ページ" }).getByRole("link", { name: "受信一覧" }).click();
  await expect(page).toHaveURL(/\/received$/);
  const rows = page.getByTestId("received-row");
  // 期間の初期設定は今日。見本の受信は 2026-10-17 なので、今日には無い（表の枠と見出しは残し、事実と次の手の 2 行）
  await expect(page.getByTestId("received-period-today")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("received-none")).toHaveText("今日の受信はありません。期間を変えてください。");
  await expect(page.getByTestId("received-table").locator("thead th")).toHaveCount(8);
  // 期間を指定：開始日と終了日がそろうと、頁を読み直さずに読み、URL にも期間が残る
  await page.getByTestId("received-period-range").click();
  await page.getByTestId("received-from").fill("2026-10-17");
  await page.getByTestId("received-to").fill("2026-10-17");
  await expect(page).toHaveURL(/\/received\?period=range&from=2026-10-17&to=2026-10-17$/);
  await expect(rows).toHaveCount(8);
  await expect(page.getByTestId("received-period")).toHaveText("2026/10/17〜2026/10/17・新しい順");
  // 状態の列：見本の最初の行は落ち着く前（受信中）、ほかは受信完了。札は文字と印を持つ
  await expect(rows.first().getByTestId("received-state")).toHaveText("◔受信中");
  await expect(rows.nth(1).getByTestId("received-state")).toHaveText("✓受信完了");
  // 見本の変更の記録の時刻 20261017T133200 は UTC。TZ=Asia/Tokyo の時刻で出す（docs/spec.md の 3.3）
  await expect(rows.first().getByTestId("received-at")).toHaveText("2026/10/17 22:32:00");
  await expect(rows.first()).toContainText("DTG_SCU");
  await expect(rows.first()).toContainText("JP-TEST-0004");
  await expect(page.getByTestId("received-origin")).toHaveText(["インポート"]);
  // 1 行は 28px ほど
  expect((await rows.first().boundingBox())!.height).toBeLessThanOrEqual(30);
  // 行から検査の一覧へ移れる（患者 ID で絞る）
  await rows.first().getByRole("link", { name: "検査一覧で表示" }).click();
  await expect(page).toHaveURL(/q=JP-TEST-0004/);
  await expect(page.getByTestId("study-count")).toHaveText("2");
});

test("受信一覧の「検査一覧で表示」：ボタンの形で、押すとその検査を選び、詳細を開き、その行が見える形で検査一覧を開く", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto(RECEIVED_SAMPLE_DAY);
  const target = page.getByTestId("received-row").nth(3);
  const open = target.getByRole("link", { name: "検査一覧で表示" });
  // ボタンの形（枠と地。文字のリンクの下線ではない）
  expect(await open.evaluate((el) => getComputedStyle(el).textDecorationLine)).toBe("none");
  expect(await open.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("1px");
  const href = (await open.getAttribute("href"))!;
  const uid = new URL(href, "http://x").searchParams.get("studyUid")!;
  expect(uid).toMatch(/^[\d.]+$/);
  await open.click();
  const row = page.locator(`[data-testid=study-table] tr[data-study-uid="${uid}"]`);
  await expect(row).toHaveAttribute("aria-selected", "true");
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();
  await expect(page.getByTestId("study-detail")).toHaveAttribute("data-study-uid", uid);
  await expect(page.getByTestId("series-strip")).toHaveAttribute("data-loaded", "true");
  // 選んだ検査は URL に残さない（開き直すと、選ばない一覧になる）
  await expect(page).not.toHaveURL(/studyUid=/);

  // 形の誤った UID・一覧に無い UID では、何も選ばない
  // （何も選ばないときは、詳細の場所を出さず、一覧が全幅。案内の文は出さない）
  await page.goto(`/?${new URLSearchParams({ studyUid: "1.2.3" })}`);
  await expect(page.getByTestId("study-list-scroll")).toBeVisible();
  await expect(page.getByTestId("detail-pane")).toHaveCount(0);
  await page.goto(`/?${new URLSearchParams({ studyUid: "1.2'3" })}`);
  await expect(page.getByTestId("study-list-scroll")).toBeVisible();
  await expect(page.getByTestId("detail-pane")).toHaveCount(0);
});

test("受信一覧の絞り込み：送信元 AE・検索で絞り、前に開いた後に受信した行に「新着」を付ける。再読み込みで頁を読み直さずに読み直す", async ({ page }) => {
  await asRole(page, "一般");
  // 前に開いたのは 2026-10-17 21:00（JST）とする。見本の受信は 18:01〜22:32 なので、21:00 より後の行が新着
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("tsunagi-dicom.receivedSeen", "2026-10-17T12:00:00Z");
      sessionStorage.setItem("seeded", "1");
    }
  });
  await page.goto(RECEIVED_SAMPLE_DAY);
  const rows = page.getByTestId("received-row");
  await expect(rows).toHaveCount(8);
  const fresh =await rows.evaluateAll((els) => els.filter((el) => el.hasAttribute("data-new")).length);
  expect(fresh).toBeGreaterThan(0);
  expect(fresh).toBeLessThan(8);
  await expect(page.getByTestId("received-only-new")).toHaveText(`新着のみ（${fresh}）`);
  await page.getByTestId("received-only-new").click();
  await expect(rows).toHaveCount(fresh);
  await expect(page.getByTestId("received-count")).toHaveText(String(fresh));
  await page.getByTestId("received-only-new").click();

  // 送信元 AE（読んだ行にあるものから選ぶ）と検索
  await page.getByTestId("received-source").selectOption("インポート");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().getByTestId("received-origin")).toHaveText("インポート");
  await page.getByTestId("received-source").selectOption("");
  await page.getByTestId("received-search").fill("JP-TEST-0004");
  await expect(rows).toHaveCount(2);
  await page.getByTestId("received-search").fill("該当しない語");
  await expect(page.getByTestId("received-empty")).toHaveText("該当する受信履歴はありません");
  await page.getByTestId("received-search").fill("");

  // 再読み込み：画面の API から読み直す（頁は読み直さない）。新しく届いた行（答えに足した合成の行）が出て新着になり、
  // ほかの行の新着の印は、開いている間は前に開いた時刻のまま
  await page.route("**/api/receive-log?**", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { items: { receivedAt: string; remoteAet: string | null; study: Record<string, unknown> }[] };
    body.items.unshift({ ...body.items[0]!, receivedAt: "2026-10-17T14:00:00Z", remoteAet: "NEW_SCU", study: { ...body.items[0]!.study, patientId: "JP-TEST-NEW" } });
    await route.fulfill({ response: res, json: body });
  });
  await page.getByTestId("received-reload").click();
  await expect(rows).toHaveCount(9);
  await expect(rows.first()).toContainText("JP-TEST-NEW");
  await expect(rows.first()).toHaveAttribute("data-new", "true");
  expect(await rows.evaluateAll((els) => els.filter((el) => el.hasAttribute("data-new")).length)).toBe(fresh + 1);
  // 選んだ送信元が、次の再読み込みで読んだ範囲から消えても、選択の欄は替わらず、絞り込みと食い違わない
  await page.getByTestId("received-source").selectOption("NEW_SCU");
  await expect(rows).toHaveCount(1);
  await page.unroute("**/api/receive-log?**");
  const reload = page.waitForResponse((r) => r.url().includes("/api/receive-log?") && r.status() === 200);
  await page.getByTestId("received-reload").click();
  await reload;
  await expect(page.getByTestId("received-source")).toHaveValue("NEW_SCU");
  await expect(page.getByTestId("received-empty")).toBeVisible();
  await page.getByTestId("received-source").selectOption("");
  await expect(rows).toHaveCount(8);

  // 開き直すと、前に見た受信日時はいちばん新しい行になり、新着は無い
  await page.reload();
  await expect(rows).toHaveCount(8);
  await expect(page.getByTestId("received-new")).toHaveCount(0);
  await expect(page.getByTestId("received-only-new")).toBeDisabled();
});

test("受信一覧の上限とページ送り：期間の中が 1,000 件を超えたら上限の知らせを出し、1 ページ 50 件（20・100 も選べる）で送る", async ({ page }) => {
  await asRole(page, "一般");
  // 画面の API の答えを、上限を超えた形（120 行と overLimit）に替える
  await page.route("**/api/receive-log?**", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { items: { receivedAt: string; study: Record<string, unknown> }[]; overLimit: boolean };
    const base = body.items[0]!;
    body.items = Array.from({ length: 120 }, (_, i) => ({
      ...base,
      receivedAt: new Date(Date.parse("2026-10-17T14:00:00Z") - i * 60_000).toISOString().replace(/\.\d+Z$/, "Z"),
      study: { ...base.study, patientId: `JP-TEST-P${String(i).padStart(3, "0")}`, studyInstanceUid: `1.2.3.${i}` },
    }));
    body.overLimit = true;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(RECEIVED_SAMPLE_DAY);
  await page.getByTestId("received-reload").click();
  const rows = page.getByTestId("received-row");
  await expect(page.getByTestId("received-over-limit")).toHaveText("受信が 1,000 件を超えたため、新しい 1,000 件だけを出しています。期間を狭めてください。");
  await expect(page.getByTestId("received-over-limit")).toHaveAttribute("data-kind", "warn");
  // 並び：検索の帯 → 上限の知らせ → 件数の行 → 表 → ページ送り
  const order = await page.evaluate(() =>
    ["received-filters", "received-over-limit", "received-count", "received-table", "received-pager"].map(
      (id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top,
    ),
  );
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  await expect(page.getByTestId("received-count")).toHaveText("120");
  await expect(rows).toHaveCount(50);
  await expect(page.getByTestId("received-range")).toHaveText("1〜50 件目／全 120 件");
  await expect(page.getByTestId("received-prev")).toBeDisabled();
  await page.getByTestId("received-next").click();
  await expect(page.getByTestId("received-range")).toHaveText("51〜100 件目／全 120 件");
  await expect(rows.first()).toContainText("JP-TEST-P050");
  await page.getByTestId("received-next").click();
  await expect(rows).toHaveCount(20);
  await expect(page.getByTestId("received-next")).toBeDisabled();
  await page.getByTestId("received-page-size").selectOption("20");
  await expect(page.getByTestId("received-range")).toHaveText("1〜20 件目／全 120 件");
  await expect(page.getByTestId("received-page-no")).toHaveText("1 / 6");
  // 絞り込むと、絞った行にページ送りを当て、1 ページ目に戻る
  await page.getByTestId("received-search").fill("JP-TEST-P11");
  await expect(rows).toHaveCount(10);
  await expect(page.getByTestId("received-range")).toHaveText("1〜10 件目／全 10 件");
});

test("受信一覧のキーボード：帯の欄から Tab で表の行へ進み、Enter・Space で選び、Tab で行の操作へ進む。Esc で選びを外す", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto(RECEIVED_SAMPLE_DAY);
  const rows = page.getByTestId("received-row");
  await expect(rows).toHaveCount(8);
  // 帯の最後に押せる欄（新着のみは新着が無いと、条件をクリアは絞っていないと押せない）から、件数の行の再読み込み、表の行の順
  await page.getByTestId("received-search").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("received-reload")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(rows.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press(" ");
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  // 選んだ行は太字にしない（幅が変わる）
  expect(await rows.nth(1).getByTestId("received-at").evaluate((el) => Number(getComputedStyle(el).fontWeight))).toBeLessThan(700);
  // 行の中の操作（検査一覧で表示）は、その行の次に止まる
  await page.keyboard.press("Tab");
  await expect(rows.nth(1).getByTestId("received-open")).toBeFocused();
});

test("接続先：一般は名称と AE タイトルを見て接続確認ができ、ホスト:ポートは見えない。管理者には出る", async ({ page }) => {
  await asRole(page, "一般");
  await page.goto("/modalities");
  const rows = page.getByTestId("modality-row");
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId("modality-table")).not.toContainText("192.0.2.");
  await page.locator('[data-modality="dtg"]').getByTestId("echo").click();
  // 結果は札と時刻つき（「成功 10:32:05」。失敗は札・時刻・理由の 1 句。docs/spec.md の 3.3）
  await expect(page.locator('[data-modality="dtg"]').getByTestId("echo-result")).toHaveText(/成功\s*\d{2}:\d{2}:\d{2}$/);
  await expect(page.getByTestId("echo-notice")).toContainText("dtg に接続できました");
  await page.locator('[data-modality="offline"]').getByTestId("echo").click();
  const offline = page.locator('[data-modality="offline"]').getByTestId("echo-result");
  await expect(offline).toHaveText(/失敗\s*\d{2}:\d{2}:\d{2}原因は分かりません。管理者に、登録の確認を頼んでください。$/);
  // 相手が答えなかったのか断られたのかは応答から分からないので、「応答がありません」などとは書かない
  await expect(offline).not.toContainText("応答がありません");

  // すべて接続確認：失敗があっても全部の行に結果が出て、件数を知らせる
  await page.getByTestId("echo-all").click();
  await expect(page.getByTestId("echo-notice")).toContainText("3 件のうち、1 件に接続できませんでした");
  await expect(page.getByTestId("echo-result")).toHaveCount(3);
  await expect(page.getByTestId("echo-all")).toBeEnabled();

  await asRole(page, "管理者");
  await page.goto("/modalities");
  await expect(page.locator('[data-modality="dtg"]')).toContainText("192.0.2.20:11112");
  await expect(page.getByRole("columnheader", { name: "ホスト名:ポート番号" })).toBeVisible();
  await page.locator('[data-modality="offline"]').getByTestId("echo").click();
  await expect(page.locator('[data-modality="offline"]').getByTestId("echo-why")).toContainText("ホスト名・ポート番号・AEタイトルを確認して");
});

test("接続先：確認そのものを終えられなかったときは、接続できなかったと書かない", async ({ page }) => {
  await asRole(page, "一般");
  await page.route("**/api/modalities/dtg/echo", (route) => route.abort());
  await page.goto("/modalities");
  const row = page.locator('[data-modality="dtg"]');
  await row.getByTestId("echo").click();
  await expect(row.getByTestId("echo-why")).toContainText("サーバーに接続できませんでした");
  await expect(page.getByTestId("echo-notice")).toContainText("dtg の接続確認を終えられませんでした");
  await expect(page.getByTestId("echo-notice")).not.toContainText("dtg に接続できませんでした");
});

test("接続先：確認中は札を出し、その行のボタンを押せなくする。二度押しても要求は 1 回", async ({ page }) => {
  await asRole(page, "一般");
  let calls = 0;
  await page.route("**/api/modalities/dtg/echo", async (route) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.goto("/modalities");
  const row = page.locator('[data-modality="dtg"]');
  await expect(row.getByTestId("echo-cell")).toHaveText("—");
  await row.getByTestId("echo").dblclick();
  await expect(row.getByTestId("echo-result")).toContainText("確認中");
  await expect(row.getByTestId("echo")).toBeDisabled();
  await expect(page.getByTestId("echo-all")).toBeDisabled();
  await expect(row.getByTestId("echo-result")).toContainText("成功");
  await expect(row.getByTestId("echo")).toBeEnabled();
  expect(calls).toBe(1);
});

// 期待の変更：前は「医師・閲覧には受け取り・機器の頁の道が無い」。役割を管理者と一般の2つにした（2026-10-20）ので、
// 一般には普段使う頁の道があり、管理者だけの頁（ビューア設定）の道は無く、開いても断ることを見る（docs/spec.md の 3.6）
test("一般の画面には、普段使う頁の道があり、管理者だけの頁の道は出さない。開いても断る", async ({ page }) => {
  await asRole(page, "一般");
  const nav = page.getByRole("navigation", { name: "ページ" });
  await expect(nav.getByRole("link", { name: "検査一覧" })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "受信一覧" })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "接続先" })).toHaveCount(1);
  await expect(nav.getByRole("link", { name: "ビューア設定" })).toHaveCount(0);
  await page.goto("/admin/viewers");
  // 期待の変更：権限の無い頁は、alert の段落ではなく空の状態（denied）で出す。事実・次の手・検査一覧への道の 3 つ
  const denied = page.getByRole("main");
  await expect(denied).toContainText("この画面は管理者のみ利用できます。");
  await expect(denied).toContainText("管理者に役割の変更を頼んでください。");
  await expect(denied.getByRole("link", { name: "検査一覧へ" })).toHaveAttribute("href", "/");
  await expect(page).toHaveURL(/\/admin\/viewers$/);
  expect((await page.request.get("/api/admin/viewer-defaults")).status()).toBe(403);
  expect((await page.request.get("/api/receive-log")).status()).toBe(200);
  // 管理者には、ビューア設定の道がある
  await asRole(page, "管理者");
  await expect(page.getByRole("navigation", { name: "ページ" }).getByRole("link", { name: "ビューア設定" })).toHaveCount(1);
});

test("検証モードで書き込みを止めているときは、送るのボタンが無く、送る要求も断る", async ({ page }) => {
  await asRole(page, "管理者");
  await expect(page.getByTestId("dev-mode-band")).toContainText("書き込み：無効");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  await expect(page.getByTestId("study-detail")).toBeVisible();
  await expect(page.getByTestId("send-open")).toHaveCount(0);
  await expect(page.getByTestId("export-zip")).toHaveCount(0);
  await expect(page.getByTestId("delete-open")).toHaveCount(0);
  const res = await page.request.post(`/api/studies/${STUDY}/send`, {
    data: { modality: "dtg", requestId: crypto.randomUUID() },
    headers: { origin: "http://127.0.0.1:3100" },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error).toContain("検証モードでは書き込みが無効です");
});
