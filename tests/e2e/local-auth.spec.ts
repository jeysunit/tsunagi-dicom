import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { totpAt, totpStep } from "../../src/lib/auth/totp";
import { E2E_ADMIN, LOCAL_BASE_URL } from "../../playwright.config";

// AUTH_MODE=local（段 1b）：ログイン・パスワードの規則・TOTP・ログインの一時停止・画面のロック・利用者の棚卸し・役割。
// サーバーは LOGIN_LOCK_THRESHOLD=3・LOGIN_LOCK_MINUTES=1・SCREEN_LOCK_MINUTES=1・MFA_REQUIRED=true（playwright.config.ts）。
// SCREEN_UNLOCK_REQUIRE_TOTP は既定（false：画面のロックはパスワードだけで解く。true のときは単体の試験で見る）。
// 頁の流れが前の試験の結果に依るので、順に流す。

test.describe.configure({ mode: "serial" });
test.use({ baseURL: LOCAL_BASE_URL });

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const ADMIN_PASSWORD = "Kq7v-Changed-4zx9";
const DOCTOR = { username: "e2e-doctor", initial: "Rb6w-Init-Pass-8mz2", password: "Mz3t-Own-Pass-8vb7" };
const LOCKED = { username: "e2e-locked", initial: "Hp2n-Init-Pass-5tw1" };

/** 利用者ごとに、最後に使った TOTP の段（サーバーは同じ段・前の段の使い回しを断る） */
const lastStep = new Map<string, number>();

/** まだ使っていない段の確認の番号。サーバーが受ける窓（いまの段の ±1）に入るまで待つ */
async function nextCode(secret: string): Promise<string> {
  for (;;) {
    const now = totpStep(Date.now());
    const step = Math.max((lastStep.get(secret) ?? -Infinity) + 1, now - 1);
    if (step <= now + 1) {
      lastStep.set(secret, step);
      return totpAt(secret, step * 30_000);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function newPage(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: LOCAL_BASE_URL, locale: "ja-JP" });
  return { context, page: await context.newPage() };
}

async function submitLogin(page: Page, username: string, password: string) {
  await page.goto("/login");
  const form = page.getByRole("form", { name: "ログイン" });
  await form.getByLabel("ユーザーID").fill(username);
  await form.getByLabel("パスワード").fill(password);
  await form.getByRole("button", { name: "ログイン" }).click();
}

/** 登録の頁で秘密を読み、確認の番号で登録する */
async function enrollTotp(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/login\/enroll$/);
  await expect(page.getByTestId("totp-qr")).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").getAttribute("data-secret"))!;
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  // 画面の言葉は docs/spec.md の 2.2（登録する→設定を完了・確認の番号→認証コード）
  const form = page.getByRole("form", { name: "設定を完了" });
  await form.getByLabel(/認証コード/).fill(await nextCode(secret));
  await form.getByRole("button", { name: "設定を完了" }).click();
  return secret;
}

async function changeOwnPassword(page: Page, password: string) {
  await expect(page).toHaveURL(/\/login\/password$/);
  const form = page.getByRole("form", { name: "パスワードの変更" });
  await form.locator('input[name="newPassword"]').fill(password);
  await form.locator('input[name="confirm"]').fill(password);
  await form.getByRole("button", { name: "変更" }).click();
}

/** 検査の一覧の1行目の、患者 ID・氏名・StudyInstanceUID（合成の見本の値） */
async function patientValues(page: Page): Promise<string[]> {
  const row = page.getByTestId("study-table").locator("tbody tr[data-study-uid]").first();
  const values = [
    // 列：検査日時・患者 ID・氏名…（src/components/studies/study-browser.tsx。サムネイルの列は 1 行の一覧で、状態の列は段 3 で外した）
    (await row.locator("td").nth(1).innerText()).trim(),
    (await row.getByTestId("patient-name").innerText()).trim(),
    (await row.getAttribute("data-study-uid")) ?? "",
  ];
  for (const v of values) expect(v.length).toBeGreaterThan(3);
  return values;
}

/** 頁の HTML（描画の元のデータを含む）に、患者の値が無い（読み直しの後） */
async function expectNoPatientValues(page: Page, values: string[]) {
  await expect
    .poll(async () => {
      // 読み直しの途中は頁を読めないことがあるので、そのときは次の回に見直す
      const html = await page.content().catch(() => null);
      return html === null ? ["(読み直しの途中)"] : values.filter((v) => html.includes(v));
    })
    .toEqual([]);
}

let admin: { context: BrowserContext; page: Page };
let adminSecret = "";

test.beforeAll(async ({ browser }) => {
  admin = await newPage(browser);
});
test.afterAll(async () => {
  await admin.context.close();
});

test("ログインしていなければ、頁はログインへ移し、API と中継は 401", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByTestId("not-for-diagnostic-use")).toHaveCount(0);
  // 検証モードの帯は出ない
  await expect(page.getByTestId("dev-mode-band")).toHaveCount(0);
  expect((await request.get("/api/studies")).status()).toBe(401);
  expect((await request.get(`/api/dicom-web/studies/${STUDY}/metadata`)).status()).toBe(401);
  expect((await request.get("/api/audit/verify")).status()).toBe(401);
  expect((await request.get("/api/admin/users")).status()).toBe(401);
});

test("最初の管理者：TOTP を登録し、決められたパスワードを変えてから使える。cookie は HttpOnly・Secure・SameSite=Strict", async () => {
  test.setTimeout(90_000);
  const { page, context } = admin;
  await submitLogin(page, E2E_ADMIN.username, E2E_ADMIN.password);
  await expect(page).toHaveURL(/\/login\/enroll$/);

  // __Host- の名前：ブラウザは Secure・Path=/・Domain 無しのときだけ受ける
  const cookie = (await context.cookies()).find((c) => c.name === "__Host-tsunagi_session");
  expect(cookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict", path: "/" });

  // 途中のセッションでは、まだ検査を見られない
  expect((await page.request.get("/api/studies")).status()).toBe(401);
  adminSecret = await enrollTotp(page);

  // パスワードの規則：よく使われるもの・短いもの・英字だけのものは断る
  await expect(page).toHaveURL(/\/login\/password$/);
  const form = page.getByRole("form", { name: "パスワードの変更" });
  for (const [bad, reason] of [
    ["password123", "よく使われる"],
    ["ab1", "8 文字以上"],
    ["onlyletters", "英字と数字を含めてください"],
  ] as const) {
    await form.locator('input[name="newPassword"]').fill(bad);
    await form.locator('input[name="confirm"]').fill(bad);
    await form.locator('input[name="newPassword"]').evaluate((el) => el.removeAttribute("minlength"));
    await form.getByRole("button", { name: "変更" }).click();
    await expect(form.getByRole("alert")).toContainText(reason);
  }
  await changeOwnPassword(page, ADMIN_PASSWORD);

  await expect(page).toHaveURL(`${LOCAL_BASE_URL}/`);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("current-user")).toContainText("e2e-admin（管理者）");
  expect((await (await page.request.get("/api/audit/verify")).json()).ok).toBe(true);
});

test("利用者の棚卸し：一覧に最後のログインを出し、管理者が利用者を作り、役割を変える（大事な操作の前に再認証）", async () => {
  test.setTimeout(90_000);
  const { page } = admin;
  await page.goto("/admin/users");
  const table = page.getByTestId("user-table");
  const adminRow = table.locator(`tr[data-username="${E2E_ADMIN.username}"]`);
  // 画面の言葉は docs/spec.md の 2.2（登録あり→設定済み・まだ無い→—・利用者を作る→ユーザーの追加・本人の確かめ→再認証など）
  await expect(adminRow).toContainText("設定済み");
  await expect(adminRow.getByTestId("last-login")).not.toHaveText("—");

  const form = page.getByRole("form", { name: "ユーザーの追加" });
  // 規則に合わない最初のパスワードは断る
  await form.locator('input[name="username"]').fill(DOCTOR.username);
  await form.getByLabel("表示名").fill("試験 医師");
  // 役割は管理者と一般の2つ（2026-10-20）。前の閲覧で作り医師に変えていた流れを、管理者で作り一般に変える流れにした
  await form.locator('select[name="role"]').selectOption("admin");
  await form.locator('input[name="password"]').fill("qwerty123");
  await form.getByRole("button", { name: "追加" }).click();

  // 利用者の管理は大事な操作なので、BFF が再認証を求める。違うパスワードでは通らない。
  // 削除の再認証はパスワードだけ（2026-10-20）だが、利用者の管理は TOTP を登録した管理者には認証コードも求める
  // （パスワードとセッションだけで管理者を作り足させない。docs/spec.md の 3.6）
  const reauth = page.getByRole("form", { name: "再認証" });
  await expect(reauth).toBeVisible();
  await reauth.locator('input[name="password"]').fill("wrong-Pass-1x");
  await reauth.locator('input[name="code"]').fill("000000");
  await reauth.getByRole("button", { name: "認証して続行" }).click();
  await expect(reauth.getByRole("alert")).toContainText("合いません");
  await reauth.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await reauth.locator('input[name="code"]').fill(await nextCode(adminSecret));
  await reauth.getByRole("button", { name: "認証して続行" }).click();
  await expect(reauth).toHaveCount(0);
  // 通ったら同じ操作をもう一度送る（ここでは規則に合わない最初のパスワードで断られる）
  await expect(page.getByRole("main").getByRole("alert")).toContainText("よく使われる");

  await form.locator('input[name="password"]').fill(DOCTOR.initial);
  await form.getByRole("button", { name: "追加" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("ユーザーを追加しました");
  const row = table.locator(`tr[data-username="${DOCTOR.username}"]`);
  await expect(row.getByTestId("last-login")).toHaveText("—");

  // 役割の変更（管理者 → 一般）。役割の選択欄は管理者と一般の2つだけ
  await expect(row.getByLabel(`${DOCTOR.username} の役割`).locator("option")).toHaveText(["管理者", "一般"]);
  await row.getByLabel(`${DOCTOR.username} の役割`).selectOption("general");
  await expect(page.getByRole("main").getByRole("status")).toContainText("役割を「一般」に変更しました");
  await page.reload();
  await expect(table.locator(`tr[data-username="${DOCTOR.username}"]`).getByLabel(`${DOCTOR.username} の役割`)).toHaveValue(
    "general",
  );
  // 自分の二要素認証のリセットのボタンは出さない（別の管理者が行う）
  await expect(adminRow.getByRole("button", { name: "二要素認証をリセット" })).toHaveCount(0);

  // ログインの一時停止の試験に使う利用者
  await form.locator('input[name="username"]').fill(LOCKED.username);
  await form.getByLabel("表示名").fill("試験 一時停止");
  await form.locator('input[name="password"]').fill(LOCKED.initial);
  await form.getByRole("button", { name: "追加" }).click();
  await expect(table.locator(`tr[data-username="${LOCKED.username}"]`)).toBeVisible();

  const list = await (await page.request.get("/api/admin/users")).json();
  expect(JSON.stringify(list)).not.toMatch(/argon2id|passwordHash|totpSecret/);
});

test("検査一覧の自動更新を止める（STUDY_LIST_REFRESH_SECONDS=0）：印を出さず、一覧の版を読まない", async () => {
  const { page } = admin;
  const versionReads: string[] = [];
  const onRequest = (req: { url: () => string }) => {
    if (req.url().endsWith("/api/studies/version")) versionReads.push(req.url());
  };
  page.on("request", onRequest);
  await page.goto("/");
  await expect(page.getByTestId("study-table")).toBeVisible();
  await expect(page.getByTestId("list-refresh")).toHaveCount(0);
  // 開いた直後とタブに戻ったときにも読まない
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForTimeout(1_500);
  expect(versionReads).toEqual([]);
  page.off("request", onRequest);
});

test("役割ごとにできる操作：一般は検査と画像を見られ、利用者の管理と監査の確かめはできない", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await newPage(browser);
  await submitLogin(page, DOCTOR.username, DOCTOR.initial);
  await enrollTotp(page);
  await changeOwnPassword(page, DOCTOR.password);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("current-user")).toContainText("e2e-doctor（一般）");
  await expect(page.getByRole("link", { name: "ユーザー管理" })).toHaveCount(0);

  expect((await page.request.get("/api/studies")).status()).toBe(200);
  // 中継は役割の確かめを通り、モック（WADO-RS の見本が無い）まで届く
  const relay = await page.request.get(`/api/dicom-web/studies/${STUDY}/series/1.2.826.0.1.3680043.8.498.1/metadata`);
  expect(relay.status()).toBe(404);
  expect((await relay.json()).error).toBe("見本に無い");
  // 中継は検索を返さない（段 1a の決まりのまま）
  expect((await page.request.get("/api/dicom-web/studies")).status()).toBe(404);

  expect((await page.request.get("/api/audit/verify")).status()).toBe(403);
  expect((await page.request.get("/api/admin/users")).status()).toBe(403);
  // 再認証を求めない時間の中でも、管理者でなければ利用者の管理はできない
  expect(
    (
      await page.request.patch(`/api/admin/users/x`, {
        headers: { origin: LOCAL_BASE_URL, "x-csrf-token": "forged" },
        data: { role: "admin" },
      })
    ).status(),
  ).toBe(403);
  await page.goto("/admin/users");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("管理者のみ利用できます");
  await context.close();
});

test("CSRF の対策：token の無い要求・別の Origin の要求は断る", async () => {
  const { page } = admin;
  await page.goto("/");
  const origin = LOCAL_BASE_URL;
  const noToken = await page.request.post("/api/auth/lock", { headers: { origin }, data: { reason: "manual" } });
  expect(noToken.status()).toBe(403);
  for (const headers of [{origin}, {origin,"x-csrf-token":"forged"}, {origin:"https://attacker.example"}] as Record<string,string>[]) {
    expect((await page.request.post("/api/hl7/resolve", { headers, data: { writeId: crypto.randomUUID(), note: "試験" } })).status()).toBe(403);
  }
  const wrongToken = await page.request.post("/api/auth/lock", {
    headers: { origin, "x-csrf-token": "forged" },
    data: { reason: "manual" },
  });
  expect(wrongToken.status()).toBe(403);
  const noOrigin = await page.request.post("/api/auth/lock", { data: { reason: "manual" } });
  expect(noOrigin.status()).toBe(403);
  const crossSite = await page.request.post("/api/auth/login", {
    headers: { origin: "https://attacker.example" },
    data: { username: E2E_ADMIN.username, password: ADMIN_PASSWORD },
  });
  expect(crossSite.status()).toBe(403);
  // 断ったので、画面はロックしていない
  expect((await page.request.get("/api/studies")).status()).toBe(200);
});

test("段 4：管理者が受け取りの記録で届いた検査を見て、機器を確かめ、検査をほかの機器へ送る（モックの一巡り）", async () => {
  test.setTimeout(60_000);
  const { page } = admin;
  const before = await (await page.request.get("/api/audit/verify")).json();

  // 届いた：受け取りの記録に、検査装置の試験用のソフト（DTG_SCU）から受けた検査が出る
  await page.goto("/received");
  await expect(page.getByTestId("received-row").first()).toContainText("DTG_SCU");

  // 送り先を確かめる（C-ECHO）
  await page.goto("/modalities");
  await page.locator('[data-modality="dtg"]').getByTestId("echo").click();
  await expect(page.locator('[data-modality="dtg"]').getByTestId("echo-result")).toHaveText(/^成功 \d{2}:\d{2}:\d{2}$/);

  // 送る：詳細のパネルの「送る」から、確かめの画面を通して送り、仕事の終わりまで出す
  await page.goto("/");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  await page.getByTestId("send-open").click();
  const panel = page.getByTestId("send-panel");
  await panel.getByTestId("send-modality").selectOption("dtg");
  await expect(panel.getByTestId("send-confirm")).toContainText("JP-TEST-0004");
  await expect(panel.getByTestId("send-confirm")).toContainText("dtg（DTG_SCP）");
  await panel.getByTestId("send-submit").click();
  // 受け付けた後は、同じ画面から重ねて送らない（実行のボタンを外し、「閉じる」だけ。docs/spec.md の 3.4・UX のレビューの H7）
  await expect(panel.getByTestId("send-submit")).toHaveCount(0);
  await expect(panel.getByTestId("send-close")).toHaveText("閉じる");
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Success", { timeout: 15_000 });
  // 結果には送信先と時刻を出す（前は「送った」だけ）
  await expect(panel.getByTestId("send-status")).toHaveText(/^送信完了：dtg（DTG_SCP） へ \d+ 画像（\d{2}:\d{2}:\d{2}）$/);
  await expect(panel.getByTestId("send-submit")).toHaveCount(0);
  // 閉じて開き直すと、新しい送信の確かめの画面になる
  await panel.getByTestId("send-close").click();
  await page.getByTestId("send-open").click();
  await expect(page.getByTestId("send-panel").getByTestId("send-submit")).toBeVisible();
  await expect(page.getByTestId("send-panel").getByTestId("send-status")).toHaveCount(0);

  // CSRF：token の無い送る要求は断る
  const noToken = await page.request.post(`/api/studies/${STUDY}/send`, {
    headers: { origin: LOCAL_BASE_URL },
    data: { modality: "dtg", requestId: crypto.randomUUID() },
  });
  expect(noToken.status()).toBe(403);

  // 記録：受け取りの記録・C-ECHO・送る（呼ぶ前・呼んだ後・終わり）が足され、つなぎは壊れていない
  const after = await (await page.request.get("/api/audit/verify")).json();
  expect(after.ok).toBe(true);
  expect(after.checked).toBeGreaterThanOrEqual(before.checked + 5);
});

test("詳細の操作の行：開く・送信・エクスポートが同じ行の左から並び、削除は同じ行の右端に離れる", async () => {
  const { page } = admin;
  // 1 行に収まる幅で確かめる（狭い詳細では、入りきらない削除が次の行の右端へ折り返す。字体で収まる幅が変わるため、行数は確かめない）
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  const group = page.getByTestId("study-detail").getByRole("group", { name: "検査の操作" });
  const open = (await group.getByTestId("open-default").boundingBox())!;
  const send = (await group.getByTestId("send-open").boundingBox())!;
  const zip = (await group.getByTestId("export-zip").boundingBox())!;
  const del = (await group.getByTestId("delete-open").boundingBox())!;
  const area = (await group.boundingBox())!;
  // 同じ 1 行（上の位置がそろう）で、左から 開く → 送信 → エクスポート
  for (const b of [send, zip, del]) expect(Math.abs(b.y - open.y)).toBeLessThanOrEqual(4);
  expect(open.x).toBeLessThan(send.x);
  expect(send.x).toBeLessThan(zip.x);
  // 削除は右端に離れる（エクスポートの右に十分な間がある）
  expect(del.x + del.width).toBeGreaterThanOrEqual(area.x + area.width - 2);
  expect(del.x).toBeGreaterThan(zip.x + zip.width + 16);
  // あとの試験（同じ画面を使い回す）のために、画面の大きさを戻す
  await page.setViewportSize({ width: 1280, height: 720 });
});

test("送信の手応え：押した直後から状態の枠、送っている間は進みと「閉じても送信は続きます」、閉じた後も状態が出て、終わったら「再送信…」", async () => {
  test.setTimeout(60_000);
  const { page } = admin;
  await page.goto("/");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  await page.getByTestId("send-open").click();
  const panel = page.getByTestId("send-panel");
  await panel.getByTestId("send-modality").selectOption("dtg");
  // 送信の要求の答えを止めておき、答えが来る前（押した直後）の画面を見る
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/studies/*/send", async (route) => {
    await held;
    await route.continue();
  });
  await panel.getByTestId("send-submit").click();
  // 押した直後から（答えが来る前に）、状態の枠と進みの帯
  // （前は、答えが来るまで状態の文字が空で、0.3 秒たってから「読み込み中」の印だけが出ていた）
  const status = panel.getByTestId("send-status");
  await expect(status).toHaveAttribute("data-state", "Starting");
  await expect(status).toContainText("送信を開始しています");
  await expect(status.getByRole("progressbar")).toBeVisible();
  // 受け付けの前は閉じられない（断られたときの知らせを見せるため）。「閉じても送信は続きます」は、受け付けた後だけ
  await expect(panel.getByTestId("send-close")).toBeDisabled();
  await expect(panel.getByTestId("send-continues")).toHaveCount(0);
  await expect(panel.getByTestId("send-again")).toHaveCount(0);
  release();
  await expect(status).toHaveAttribute("data-state", /^(Accepted|Pending|Running)$/);
  await page.unroute("**/api/studies/*/send");
  await expect(panel.getByTestId("send-close")).toBeEnabled();
  await expect(panel.getByTestId("send-continues")).toHaveText("閉じても送信は続きます");

  // 送っている間に閉じる：「送信」の横に送信中を出し、終わると送信完了に変わる（閉じていても状態を読み続ける）
  await panel.getByTestId("send-close").click();
  await expect(page.getByTestId("send-panel")).toHaveCount(0);
  const badge = page.getByTestId("send-badge");
  await expect(badge).toHaveText("送信中");
  await expect(badge).toHaveText("送信完了", { timeout: 15_000 });

  // 開き直すと結果が出て、「再送信…」で確かめの画面に戻る（送るのは「送信する」を押したとき）
  await page.getByTestId("send-open").click();
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Success");
  await expect(panel.getByTestId("send-continues")).toHaveCount(0);
  await expect(page.getByTestId("send-badge")).toHaveCount(0);
  await panel.getByTestId("send-again").click();
  await expect(panel.getByTestId("send-status")).toHaveCount(0);
  await expect(panel.getByTestId("send-submit")).toBeVisible();
  await expect(panel.getByTestId("send-confirm")).toContainText("dtg（DTG_SCP）");

  // 送信失敗：印つきの失敗の枠と「再送信…」
  await panel.getByTestId("send-modality").selectOption("offline");
  await panel.getByTestId("send-submit").click();
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Failure", { timeout: 15_000 });
  await expect(panel.getByTestId("send-status")).toContainText("送信失敗");
  await expect(panel.getByTestId("send-again")).toBeVisible();

  // ジョブの状態を読めずに止まったときは、閉じた後も「送信中」と見せない。開いて「再読み込み」で続きを読む
  await panel.getByTestId("send-again").click();
  await panel.getByTestId("send-modality").selectOption("dtg");
  await page.route("**/api/jobs/**", (route) => route.fulfill({ status: 502, json: { error: "画像サーバーに接続できません" } }));
  await panel.getByTestId("send-submit").click();
  await expect(panel.getByTestId("send-status")).toContainText("状態を取得できませんでした");
  await panel.getByTestId("send-close").click();
  await expect(page.getByTestId("send-badge")).toHaveText("状態を取得できません");
  await page.unroute("**/api/jobs/**");
  await page.getByTestId("send-open").click();
  await panel.getByRole("button", { name: "再読み込み" }).click();
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Success", { timeout: 15_000 });

  // 受け付けの前に断られた送信（403 など）は、閉じる前に画面に出る（受け付けの前は閉じられない）
  await panel.getByTestId("send-again").click();
  await page.route("**/api/studies/*/send", (route) =>
    route.request().method() === "POST" ? route.fulfill({ status: 403, json: { error: "この操作の権限がありません" } }) : route.continue(),
  );
  await panel.getByTestId("send-submit").click();
  await expect(panel.getByTestId("send-status")).toHaveAttribute("data-state", "Error");
  await expect(panel.getByTestId("send-status")).toContainText("権限");
  await page.unroute("**/api/studies/*/send");
  await panel.getByTestId("send-close").click();
});

test("ログインの一時停止：3回続けて失敗したら、正しいパスワードでも止める。管理者は解ける", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  for (let i = 0; i < 3; i++) {
    await submitLogin(page, LOCKED.username, `wrong-Pass-${i}x9`);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("ユーザーID・パスワード");
  }
  await submitLogin(page, LOCKED.username, LOCKED.initial);
  // 失敗の文言は1つ（一時停止の有無を答えの違いで知らせない）
  await expect(page.getByRole("main").getByRole("alert")).toContainText("しばらくログインできなくなります");
  await expect(page).toHaveURL(/\/login$/);

  // 管理者の一覧に一時停止が出て、解ける
  await admin.page.goto("/admin/users");
  const row = admin.page.getByTestId("user-table").locator(`tr[data-username="${LOCKED.username}"]`);
  await expect(row).toContainText("ロック中");
  await row.getByRole("button", { name: "ロック解除" }).click();
  await expect(admin.page.getByRole("main").getByRole("status")).toContainText("ロックを解除しました");

  await submitLogin(page, LOCKED.username, LOCKED.initial);
  await expect(page).toHaveURL(/\/login\/enroll$/);
  await context.close();
});

test("画面のロック：操作の無い時間が続いたら画面をぼかしてロックし、パスワードだけで解く（TOTP を登録した管理者でも）", async () => {
  test.setTimeout(120_000);
  const { page } = admin;
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("screen-lock")).toHaveCount(0);
  const patient = await patientValues(page);

  const lockRequest=page.waitForRequest("**/api/auth/lock");
  // SCREEN_LOCK_MINUTES=1
  await page.clock.fastForward("01:10");
  const lock = page.getByTestId("screen-lock");
  await expect(lock).toBeVisible();
  await expect(page.getByTestId("lockable-content")).toHaveClass(/blur-md/);
  // ぼかすだけでなく、中身（患者の情報）を頁から外す
  await expect(page.getByTestId("study-count")).toHaveCount(0);
  await expect(page.getByTestId("study-table")).toHaveCount(0);
  // 頁を読み直すので、頁の HTML（描画の元のデータ・RSC の payload を含む）にも患者の値が残らない
  await expectNoPatientValues(page, patient);
  const lockCsrf=(await lockRequest).headers()["x-csrf-token"]!;
  expect((await page.request.post("/api/hl7/resolve", {
    headers: { origin: LOCAL_BASE_URL, "x-csrf-token": lockCsrf },
    data: { writeId: crypto.randomUUID(), note: "試験" }
  })).status()).toBe(423);
  // サーバーの側もロックしている：画面の API と中継は 423、開き直しても中身を描かない
  await expect.poll(async () => (await page.request.get("/api/studies")).status()).toBe(423);
  expect((await page.request.get(`/api/dicom-web/studies/${STUDY}/metadata`)).status()).toBe(423);
  await page.reload();
  await expect(page.getByTestId("screen-lock")).toBeVisible();
  await expect(page.getByTestId("study-count")).toHaveCount(0);

  // 既定（SCREEN_UNLOCK_REQUIRE_TOTP=false）では、6桁の欄を出さない
  // 画面の言葉は docs/spec.md の 2.2（確認の番号→認証コード・ロックを解く→ロック解除など）
  await expect(lock.getByLabel(/認証コード/)).toHaveCount(0);
  await expect(lock).toContainText("パスワードを入力してロックを解除してください");

  // 違うパスワードでは解けない
  await lock.getByLabel("パスワード").fill("wrong-Pass-1x");
  await lock.getByRole("button", { name: "ロック解除" }).click();
  await expect(lock.getByRole("alert")).toContainText("パスワードが合いません");
  await expect(page.getByTestId("study-count")).toHaveCount(0);

  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByRole("button", { name: "ロック解除" }).click();
  await expect(page.getByTestId("screen-lock")).toHaveCount(0);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  expect((await page.request.get("/api/studies")).status()).toBe(200);
  expect((await (await page.request.get("/api/audit/verify")).json()).ok).toBe(true);
});

test("画面のロック：ヘッダーの「ロック」で、同じブラウザのほかのタブも読み直し、頁に患者の値を残さない", async () => {
  test.setTimeout(120_000);
  const { page, context } = admin;
  const other = await context.newPage();
  await page.goto("/");
  await other.goto("/");
  await expect(other.getByTestId("study-count")).toHaveText("8");
  const patient = await patientValues(other);

  await page.getByRole("button", { name: "画面ロック", exact: true }).click();
  await expect(page.getByTestId("screen-lock")).toBeVisible();
  await expect(other.getByTestId("screen-lock")).toBeVisible();
  await expectNoPatientValues(page, patient);
  await expectNoPatientValues(other, patient);

  // 1つのタブで解けば、ほかのタブも戻る
  const lock = page.getByTestId("screen-lock");
  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByRole("button", { name: "ロック解除" }).click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(other.getByTestId("study-count")).toHaveText("8");
  await other.close();
});

test("画面のロック：ロックの知らせ（POST）を落としても、読み直した頁・別のタブで開いた頁は BFF が中身なしで描く。解くにはパスワードが要る", async () => {
  test.setTimeout(120_000);
  // 時計を進めた管理者のタブは、操作の無い時間でロックを掛けうるので、この試験の間は閉じた頁にしておく
  await admin.page.goto("about:blank");
  const page = await admin.context.newPage();
  // ここまでの試験で、管理者は画面のロックの解除でパスワードを誤っている。パスワードだけのロックの解除と再認証は、TOTP を
  // 確かめないので、成功しても失敗の数を消さない（docs/spec.md の 3.6）。この試験の誤りで閾値（3回）に近づきすぎないよう、
  // 先に TOTP まで確かめるログインをし直して、数を0に戻す
  await page.goto("/");
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await submitLogin(page, E2E_ADMIN.username, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/login\/totp$/);
  const totp = page.getByRole("form", { name: "認証" });
  await totp.getByLabel(/認証コード/).fill(await nextCode(adminSecret));
  await totp.getByRole("button", { name: "認証" }).click();
  await expect(page).toHaveURL(`${LOCAL_BASE_URL}/`);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  const patient = await patientValues(page);

  // ロックの POST を網の切れのように落とす（このタブからは何度送り直しても届かない）
  await page.route("**/api/auth/lock", (route) => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "画面ロック", exact: true }).click();
  const lock = page.getByTestId("screen-lock");
  await expect(lock).toBeVisible();
  await expect(page.getByTestId("study-count")).toHaveCount(0);

  // 別のタブで開いても、ロックの印の cookie で BFF がロックし、中身なしで描く
  const fresh = await admin.context.newPage();
  await fresh.goto("/");
  await expect(fresh.getByTestId("screen-lock")).toBeVisible();
  await expect(fresh.getByTestId("study-count")).toHaveCount(0);
  await expectNoPatientValues(fresh, patient);
  expect((await fresh.request.get("/api/studies")).status()).toBe(423);
  await fresh.close();

  // 読み直しても、中身なしで描く（頁の HTML に患者の値が無い）
  await page.reload();
  await expect(page.getByTestId("screen-lock")).toBeVisible();
  await expectNoPatientValues(page, patient);

  // 違うパスワードでは解けない
  await lock.getByLabel("パスワード").fill("wrong-Pass-1x");
  await lock.getByRole("button", { name: "ロック解除" }).click();
  await expect(lock.getByRole("alert")).toContainText("合いません");
  await expect(page.getByTestId("study-count")).toHaveCount(0);

  await page.unroute("**/api/auth/lock");
  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByRole("button", { name: "ロック解除" }).click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  // 解いたらロックの印は消え、読み直しても中身が出る
  await page.reload();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await page.close();
});

test("画面のロック：ほかのタブの知らせを取りこぼしても、BFF の状態を確かめて閉じ、読み直す", async () => {
  test.setTimeout(120_000);
  const page = await admin.context.newPage();
  const deaf = await admin.context.newPage();
  // このタブには、タブの間の知らせ（storage の事件・BroadcastChannel）を届けない
  await deaf.addInitScript(() => {
    const original = window.addEventListener.bind(window);
    window.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "storage") return;
      return (original as (...a: unknown[]) => void)(type, ...rest);
    }) as typeof window.addEventListener;
    Object.defineProperty(window, "BroadcastChannel", { value: undefined, configurable: true });
  });
  await page.goto("/");
  await deaf.goto("/");
  await expect(deaf.getByTestId("study-count")).toHaveText("8");
  const patient = await patientValues(deaf);

  await page.getByRole("button", { name: "画面ロック", exact: true }).click();
  await expect(page.getByTestId("screen-lock")).toBeVisible();
  // 知らせは届かないが、BFF の状態の確かめ（423）で閉じる
  await expect(deaf.getByTestId("screen-lock")).toBeVisible({ timeout: 30_000 });
  await expectNoPatientValues(deaf, patient);

  const lock = page.getByTestId("screen-lock");
  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByRole("button", { name: "ロック解除" }).click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  // 知らせを受けないタブは、閉じたまま（自分で解く）
  await expect(deaf.getByTestId("screen-lock")).toBeVisible();
  await page.close();
  await deaf.close();
});

// 段 5（検査の件数が 8 であることを見るほかの試験の後に置く。モックの Orthanc の中で1件を消すため）
test("段 5：管理者が書き出し（ZIP）を落とし、検査を理由と再認証つきで消す（確かめの画面は Orthanc から読み直した値）", async ({ browser }) => {
  test.setTimeout(120_000);
  // 新しくログインしたセッション（まだ再認証していない）で流し、削除の前に必ず再認証を求められることを見る
  const fresh = await newPage(browser);
  const { page } = fresh;
  await submitLogin(page, E2E_ADMIN.username, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/login\/totp$/);
  const totp = page.getByRole("form", { name: "認証" });
  await totp.getByLabel(/認証コード/).fill(await nextCode(adminSecret));
  await totp.getByRole("button", { name: "認証" }).click();
  await expect(page).toHaveURL(/\/$/);
  const target = "1.2.826.0.1.3680043.8.498.74370219478963110549339491256573063606";
  await page.goto("/");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await page.locator(`tr[data-study-uid="${target}"]`).click();

  // 書き出し：ZIP が落ち、名前に患者の情報が無い
  const download = page.waitForEvent("download");
  await page.getByTestId("export-zip").click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^study-[0-9a-f]{8}\.zip$/);

  // 削除：確かめの画面（Orthanc から読み直した要点）→ 理由 → 再認証 → 消えた
  await page.getByTestId("delete-open").click();
  const panel = page.getByTestId("delete-panel");
  await expect(panel.getByTestId("delete-confirm")).toContainText("JP-TEST-0003");
  await expect(panel.getByTestId("delete-confirm")).toContainText("この操作は取り消せません");
  await expect(panel.getByTestId("delete-submit")).toBeDisabled();
  await panel.getByTestId("delete-reason").fill("取り違えた検査（試験）");
  await panel.getByTestId("delete-submit").click();
  // 再認証の前は消さない（パスワードだけを求め、検査はまだ一覧にある）。
  // 期待の変更：前はパスワードと認証コードを求めた。再認証は TOTP を求めない（2026-10-20。docs/spec.md の 3.6）
  const reauth = panel.getByTestId("delete-reauth");
  await expect(reauth).toBeVisible();
  await expect(reauth.getByLabel("認証コード")).toHaveCount(0);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await reauth.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await reauth.getByRole("button", { name: "認証して削除" }).click();
  // 消えると一覧を読み直し、その行（と詳細）は消える
  await expect(page.getByTestId("study-count")).toHaveText("7");
  await expect(page.locator(`tr[data-study-uid="${target}"]`)).toHaveCount(0);
  // 消したことは、一覧の上の知らせで示す（行も詳細も消えるため。docs/spec.md の 3.5・UX のレビューの H6）
  await expect(page.getByTestId("list-notice")).toContainText("検査を削除しました（JP-TEST-0003");

  // 一度通れば REAUTH_MINUTES（既定 5 分）の間は聞き直さない：続けて消すときは、理由と確かめの画面だけ
  await page.locator("tbody > tr[data-study-uid]").first().click();
  await page.getByTestId("delete-open").click();
  const second = page.getByTestId("delete-panel");
  await expect(second.getByTestId("delete-confirm")).toContainText("この操作は取り消せません");
  await second.getByTestId("delete-reason").fill("試験の2件目");
  await second.getByTestId("delete-submit").click();
  await expect(page.getByTestId("study-count")).toHaveText("6");
  await expect(page.getByTestId("delete-reauth")).toHaveCount(0);
  expect((await (await page.request.get("/api/audit/verify")).json()).ok).toBe(true);
  await fresh.context.close();
});

// 段 6（段 5 の後に置く。モックの Orthanc の中で氏名を直し、検査を1件足すため）
test("段 6：患者情報修正は同じ患者IDの検査の氏名を UID を保って直し、検査情報修正は直した検査を新しく作る（理由と再認証つき）", async ({ browser }) => {
  test.setTimeout(120_000);
  const fresh = await newPage(browser);
  const { page } = fresh;
  await submitLogin(page, E2E_ADMIN.username, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/login\/totp$/);
  const totp = page.getByRole("form", { name: "認証" });
  await totp.getByLabel(/認証コード/).fill(await nextCode(adminSecret));
  await totp.getByRole("button", { name: "認証" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/");
  const rows = page.locator("tbody > tr[data-study-uid]");
  const before = Number(await page.getByTestId("study-count").textContent());
  const uid = (await rows.last().getAttribute("data-study-uid"))!;
  await page.locator(`tr[data-study-uid="${uid}"]`).click();

  // 患者情報修正：氏名（漢字）を直す → 確認（前と後の値・当てる範囲）→ 理由 → 再認証 → 修正しました
  await page.getByTestId("modify-open").click();
  const panel = page.getByTestId("modify-panel");
  await expect(panel.getByRole("tab", { name: "患者情報修正" })).toHaveAttribute("aria-selected", "true");
  await panel.getByTestId("modify-PatientName-1").fill("試験^三郎");
  await panel.getByTestId("modify-attribute-check").click();
  const confirm = panel.getByTestId("modify-confirm");
  await expect(confirm.getByTestId("modify-row-PatientName")).toContainText("試験^三郎");
  await expect(confirm.getByTestId("modify-scope")).toContainText(/同じ患者IDの検査 \d+ 件/);
  await expect(confirm.getByTestId("modify-submit")).toBeDisabled();
  await confirm.getByTestId("modify-reason").fill("氏名の誤入力の修正（試験）");
  await confirm.getByTestId("modify-submit").click();
  const reauth = panel.getByTestId("modify-reauth");
  await expect(reauth).toBeVisible();
  await reauth.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await reauth.getByRole("button", { name: "認証して続行" }).click();
  await expect(panel.getByTestId("modify-attribute").getByTestId("modify-status")).toContainText("修正しました");
  // UID は変わらないので、同じ行に直した氏名が出る
  await expect(page.locator(`tr[data-study-uid="${uid}"]`)).toContainText("試験 三郎");
  await expect(page.getByTestId("study-count")).toHaveText(String(before));

  // 検査情報修正：検査日を直す → 確認 → 理由 → 修正する（再認証は REAUTH_MINUTES の間は聞き直さない）→ 検査が1件増える。
  // 修正の窓は開いたまま（UID が変わらないので、同じ検査の詳細のまま）
  const panel2 = page.getByTestId("modify-panel");
  await panel2.getByRole("tab", { name: "検査情報修正" }).click();
  await panel2.getByTestId("modify-StudyDate").fill("20250101");
  await panel2.getByTestId("modify-content-check").click();
  const confirm2 = panel2.getByTestId("modify-confirm");
  await expect(confirm2.getByTestId("modify-row-StudyDate")).toContainText("2025/01/01");
  await expect(confirm2.getByTestId("modify-scope")).toContainText("元の検査は残ります");
  await confirm2.getByTestId("modify-reason").fill("検査日の誤り（試験）");
  await confirm2.getByTestId("modify-submit").click();
  await expect(panel2.getByTestId("modify-content").getByTestId("modify-status")).toContainText("新しく作りました");
  await expect(page.getByTestId("study-count")).toHaveText(String(before + 1));
  await expect(page.locator(`tr[data-study-uid="${uid}"]`)).toHaveCount(1);
  expect((await (await page.request.get("/api/audit/verify")).json()).ok).toBe(true);
  await fresh.context.close();
});

test("画面のロック：ロックの画面からログアウトでき、確認の窓を挟む。前の利用者の情報は画面に残らず、監査の記録の鎖は保たれる", async ({ browser }) => {
  test.setTimeout(120_000);
  const fresh = await newPage(browser);
  const { page } = fresh;
  const login = async () => {
    await submitLogin(page, E2E_ADMIN.username, ADMIN_PASSWORD);
    await expect(page).toHaveURL(/\/login\/totp$/);
    const totp = page.getByRole("form", { name: "認証" });
    await totp.getByLabel(/認証コード/).fill(await nextCode(adminSecret));
    await totp.getByRole("button", { name: "認証" }).click();
    await expect(page).toHaveURL(/\/$/);
    // 前の試験で検査を 2 件消してあるので、件数の値は決めない
    await expect(page.getByTestId("study-count")).toBeVisible();
  };
  await login();
  const patient = await patientValues(page);
  const before = (await (await page.request.get("/api/audit/verify")).json()) as { ok: boolean; checked: number };
  expect(before.ok).toBe(true);

  await page.getByRole("button", { name: "画面ロック", exact: true }).click();
  const lock = page.getByTestId("screen-lock");
  await expect(lock).toBeVisible();
  const confirm = page.getByTestId("logout-confirm");
  const logoutButton = lock.getByRole("button", { name: "ログアウト" });
  await expect(logoutButton).toBeVisible();
  await expect(confirm).toBeHidden();

  // 押すと確認の窓が出る。初期のフォーカスはキャンセル。キャンセルでも Esc でも、ロックのまま
  await logoutButton.click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText("ロックの前に入力して保存していない内容は残りません");
  await expect(confirm.getByRole("button", { name: "キャンセル" })).toBeFocused();
  // ロックの画面（画面いっぱいの覆い）の中央に出る。窓の位置を、覆いの大きさとの比べで見る（スクロールバーの幅に左右されない）
  const box = (await confirm.boundingBox())!;
  const cover = (await lock.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - (cover.x + cover.width / 2))).toBeLessThanOrEqual(1);
  expect(Math.abs(box.y + box.height / 2 - (cover.y + cover.height / 2))).toBeLessThanOrEqual(1);
  // 窓の説明（本文）が窓に結び付いている
  await expect(confirm).toHaveAccessibleDescription(/保存していない内容は残りません/);
  // Tab・Shift+Tab で、フォーカスがロックの画面の入力欄・ボタンへ出ない（標準の機構では、窓の外の頁は操作できない。
  // 窓の端を越えるとブラウザの枠へ出ることはあるが、頁のどの要素にも移らない）
  for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(
      await page.evaluate(() => {
        const el = document.activeElement;
        return el === document.body || !!el?.closest("dialog[data-testid=logout-confirm]");
      }),
      `${key} の後のフォーカス`,
    ).toBe(true);
  }
  await confirm.getByRole("button", { name: "キャンセル" }).click();
  await expect(confirm).toBeHidden();
  await expect(lock).toBeVisible();
  await logoutButton.click();
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toBeHidden();
  await expect(lock).toBeVisible();
  // ここまでは、ログアウトしていない（ロックの BFF の状態が 423 のまま）
  await expect.poll(async () => (await page.request.get("/api/studies")).status()).toBe(423);

  // 読み直したロックの画面（BFF が中身なしで描いた頁）からも出られる（CSRF の token が頁に渡っている）
  await page.reload();
  await expect(lock).toBeVisible();
  // 同じブラウザのほかのタブ：ロックの画面で、まだ BFF に届いていないロックの覚えを持っている
  const other = await fresh.context.newPage();
  await other.goto("/");
  await expect(other.getByTestId("screen-lock")).toBeVisible();
  await other.evaluate(() => window.sessionStorage.setItem("tsunagi:pending-lock", "manual"));

  // 実行：ログインの頁へ戻り、前の利用者の情報は頁にも覚えにも残らず、セッションは使えない
  await logoutButton.click();
  const logoutResponse = page.waitForResponse((r) => r.url().endsWith("/api/auth/logout") && r.request().method() === "POST");
  await confirm.getByRole("button", { name: "ログアウトする" }).click();
  // ロックの印の cookie を、サーバーの応答（Set-Cookie）で消している（document.cookie だけでは区別できない）
  const setCookies: string[] = (await (await logoutResponse).headersArray())
    .filter((h) => h.name.toLowerCase() === "set-cookie")
    .map((h) => h.value);
  const gone = /Max-Age=0|Expires=Thu, 01 Jan 1970/i;
  expect(setCookies.find((v) => v.includes("tsunagi_lock")) ?? "", "ロックの印の cookie を消す Set-Cookie").toMatch(gone);
  expect(setCookies.find((v) => v.includes("tsunagi_session")) ?? "", "セッションの cookie を消す Set-Cookie").toMatch(gone);
  await expect(page).toHaveURL(/\/login$/);
  // ほかのタブも、ログインの頁へ移り、届いていないロックの覚えを残さない
  await expect(other).toHaveURL(/\/login$/);
  expect(await other.evaluate(() => window.sessionStorage.getItem("tsunagi:pending-lock"))).toBeNull();
  await other.close();
  await expectNoPatientValues(page, patient);
  await expect(page.getByTestId("screen-lock")).toHaveCount(0);
  const kept = await page.evaluate(() => ({
    local: Object.keys(window.localStorage).filter((k) => k.startsWith("tsunagi:")),
    session: Object.keys(window.sessionStorage).filter((k) => k.startsWith("tsunagi:")),
    cookie: document.cookie,
  }));
  expect(kept.local).toEqual([]);
  expect(kept.session).toEqual([]);
  expect(kept.cookie).not.toContain("tsunagi_lock");
  expect((await page.request.get("/api/studies")).status()).toBe(401);

  // 別の利用者が同じブラウザでログインし直せ、監査の記録の鎖（ロックと、ロックの画面からのログアウトの行を含む）が保たれる
  await login();
  const after = (await (await page.request.get("/api/audit/verify")).json()) as { ok: boolean; checked: number };
  expect(after.ok).toBe(true);
  // ロック・ロックの画面からのログアウト・ログインの 3 行以上が増える
  expect(after.checked).toBeGreaterThanOrEqual(before.checked + 3);
  await fresh.context.close();
});

test("ログアウトすると、セッションは使えない", async () => {
  const { page } = admin;
  await page.goto("/");
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/studies")).status()).toBe(401);
});
