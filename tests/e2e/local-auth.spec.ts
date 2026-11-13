import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { totpAt, totpStep } from "../../src/lib/auth/totp";
import { E2E_ADMIN, LOCAL_BASE_URL } from "../../playwright.config";

// AUTH_MODE=local（フェーズ 1b）：ログイン・パスワードの規則・TOTP・ログインの一時停止・画面のロック・利用者の棚卸し・役割。
// サーバーは LOGIN_LOCK_THRESHOLD=3・LOGIN_LOCK_MINUTES=1・SCREEN_LOCK_MINUTES=1・MFA_REQUIRED=true（playwright.config.ts）。
// SCREEN_UNLOCK_REQUIRE_TOTP は既定（false：画面のロックはパスワードだけで解く。true のときは単体の試験で見る）。
// 頁の流れが前の試験の結果に依るので、順に実行する。

test.describe.configure({ mode: "serial" });
test.use({ baseURL: LOCAL_BASE_URL });

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const ADMIN_PASSWORD = "Kq7v-Changed-4zx9";
const DOCTOR = { username: "e2e-doctor", initial: "Rb6w-Init-Pass-8mz2", password: "Mz3t-Own-Pass-8vb7" };
const LOCKED = { username: "e2e-locked", initial: "Hp2n-Init-Pass-5tw1" };

/** 利用者ごとに、最後に使った TOTP のステップ（サーバーは同じステップ・前のステップの使い回しを断る） */
const lastStep = new Map<string, number>();

/** まだ使っていないステップの確認の番号。サーバーが受ける窓（いまのステップの ±1）に入るまで待つ */
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
    // 列：検査日時・患者 ID・氏名…（src/components/studies/study-browser.tsx。サムネイルの列は 1 行の一覧で、状態の列はフェーズ 3 で外した）
    (await row.locator("td").nth(1).innerText()).trim(),
    (await row.getByTestId("patient-name").innerText()).trim(),
    (await row.getAttribute("data-study-uid")) ?? "",
  ];
  for (const v of values) expect(v.length).toBeGreaterThan(3);
  return values;
}

/** 頁の HTML（描画の元のデータを含む）に、患者の値が無い（再読み込みの後） */
async function expectNoPatientValues(page: Page, values: string[]) {
  await expect
    .poll(async () => {
      // 再読み込みの途中は頁を読めないことがあるので、そのときは次の回に見直す
      const html = await page.content().catch(() => null);
      return html === null ? ["(読み直しの途中)"] : values.filter((v) => html.includes(v));
    })
    .toEqual([]);
}

/** 画面のロックの間、上の帯に前の利用者の名前・画面ロック・ログアウトが無く、Tab でも届かない */
async function expectHeaderLocked(page: Page) {
  const header = page.getByTestId("site-header");
  await expect(header).toBeVisible();
  await expect(page.getByTestId("current-user")).toHaveCount(0);
  await expect(header).not.toContainText("e2e-admin");
  await expect(header.getByRole("button", { name: "ログアウト" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "画面ロック", exact: true })).toHaveCount(0);
  // Tab を何度押しても、上の帯の中の押しボタンに届かない（ロックの画面の外の操作ができない）
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    const inHeaderButton = await page.evaluate(
      () => !!document.activeElement?.closest('[data-testid="site-header"]') && document.activeElement?.tagName === "BUTTON",
    );
    expect(inHeaderButton).toBe(false);
  }
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
  // 画面の言葉は docs/spec.md の 2.2（登録あり→設定済み・まだ無い→—・利用者を作る→ユーザーの追加・本人の確認→再認証など）
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
  // （パスワードとセッションだけで管理者を作成させない。docs/spec.md の 3.6）
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
  // 期待の変更：前は選んだ瞬間に変更を送っていた。いまは確認の窓を挟み、誰を何から何へ替えるかを出す（H6）。
  // キャンセルなら送らず、選択欄も元の役割に戻る。初期のフォーカスはキャンセル
  const roleSelect = row.getByLabel(`${DOCTOR.username} の役割`);
  const confirm = page.getByTestId("user-confirm");
  const patches: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "PATCH" && r.url().includes("/api/admin/users/")) patches.push(r.url());
  });
  await roleSelect.selectOption("general");
  await expect(confirm).toBeVisible();
  await expect(confirm.getByRole("heading")).toHaveText(`${DOCTOR.username}（試験 医師）の役割を変更しますか？`);
  await expect(confirm).toContainText("管理者 → 一般。削除・ユーザー管理・システムの設定ができなくなります");
  await expect(confirm.getByRole("button", { name: "キャンセル" })).toBeFocused();
  await confirm.getByRole("button", { name: "キャンセル" }).click();
  await expect(confirm).toBeHidden();
  await expect(roleSelect).toHaveValue("admin");
  expect(patches).toEqual([]);
  await roleSelect.selectOption("general");
  await confirm.getByRole("button", { name: "変更する" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("役割を「一般」に変更しました");
  expect(patches).toHaveLength(1);
  await page.reload();
  await expect(table.locator(`tr[data-username="${DOCTOR.username}"]`).getByLabel(`${DOCTOR.username} の役割`)).toHaveValue(
    "general",
  );
  // 管理者への格上げも同じ窓を挟む（できるようになることを書く）。無効にするのも確認の窓。どちらもキャンセルで何も変えない
  await table.locator(`tr[data-username="${DOCTOR.username}"]`).getByLabel(`${DOCTOR.username} の役割`).selectOption("admin");
  await expect(confirm).toContainText("一般 → 管理者。削除・ユーザー管理・システムの設定ができるようになります");
  await confirm.getByRole("button", { name: "キャンセル" }).click();
  await table.locator(`tr[data-username="${DOCTOR.username}"]`).getByRole("button", { name: "無効にする" }).click();
  await expect(confirm.getByRole("heading")).toHaveText(`${DOCTOR.username}（試験 医師）を無効にしますか？`);
  await expect(confirm).toContainText("ログインできなくなります");
  await confirm.getByRole("button", { name: "キャンセル" }).click();
  await expect(confirm).toBeHidden();
  await expect(table.locator(`tr[data-username="${DOCTOR.username}"]`)).toContainText("有効");
  await expect(table.locator(`tr[data-username="${DOCTOR.username}"]`).getByLabel(`${DOCTOR.username} の役割`)).toHaveValue(
    "general",
  );
  expect(patches).toHaveLength(1);
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
  // 中継は役割の確認を通り、モック（WADO-RS の見本が無い）まで届く
  const relay = await page.request.get(`/api/dicom-web/studies/${STUDY}/series/1.2.826.0.1.3680043.8.498.1/metadata`);
  expect(relay.status()).toBe(404);
  expect((await relay.json()).error).toBe("見本に無い");
  // 中継は検索を返さない（フェーズ 1a の決まりのまま）
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
  // 期待の変更：alert の段落「管理者のみ利用できます」から、空の状態（denied）の「この画面は管理者のみ利用できます。」に替えた
  await expect(page.getByRole("main")).toContainText("この画面は管理者のみ利用できます。");
  await expect(page.getByRole("main").getByRole("link", { name: "検査一覧へ" })).toBeVisible();
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

  // 届いた：受け取りの記録に、検査装置の試験用のソフト（DTG_SCU）から受けた検査が出る（見本の受信の日 2026-10-17 の期間で開く）
  await page.goto("/received?period=range&from=2026-10-17&to=2026-10-17");
  await expect(page.getByTestId("received-row").first()).toContainText("DTG_SCU");

  // 送り先を確認する（C-ECHO）
  await page.goto("/modalities");
  await page.locator('[data-modality="dtg"]').getByTestId("echo").click();
  await expect(page.locator('[data-modality="dtg"]').getByTestId("echo-result")).toHaveText(/成功\s*\d{2}:\d{2}:\d{2}$/);

  // 送る：詳細のパネルの「送る」から、確認画面を通して送り、仕事の終わりまで出す
  await page.goto("/");
  await page.locator(`tr[data-study-uid="${STUDY}"]`).click();
  await page.getByTestId("send-open").click();
  const panel = page.getByTestId("send-panel");
  // 開いたら、最初の入力（送信先の選択欄）へフォーカスが移る
  await expect(panel.getByTestId("send-modality")).toBeFocused();
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
  // 閉じて開き直すと、新しい送信の確認画面になる
  await panel.getByTestId("send-close").click();
  // 閉じたら、開いたボタンへフォーカスが戻る（body に落ちない）
  await expect(page.getByTestId("send-open")).toBeFocused();
  await page.getByTestId("send-open").click();
  await expect(page.getByTestId("send-panel").getByTestId("send-submit")).toBeVisible();
  await expect(page.getByTestId("send-panel").getByTestId("send-status")).toHaveCount(0);

  // CSRF：token の無い送る要求は断る
  const noToken = await page.request.post(`/api/studies/${STUDY}/send`, {
    headers: { origin: LOCAL_BASE_URL },
    data: { modality: "dtg", requestId: crypto.randomUUID() },
  });
  expect(noToken.status()).toBe(403);

  // 記録：受け取りの記録・C-ECHO・送る（呼ぶ前・呼んだ後・終わり）が追加され、つなぎは壊れていない
  const after = await (await page.request.get("/api/audit/verify")).json();
  expect(after.ok).toBe(true);
  expect(after.checked).toBeGreaterThanOrEqual(before.checked + 5);
});

test("詳細の操作の行：開く・送信・エクスポートが同じ行の左から並び、削除は同じ行の右端に離れる", async () => {
  const { page } = admin;
  // 1 行に収まる幅で確認する（狭い詳細では、入りきらない削除が次の行の右端へ折り返す。字体で収まる幅が変わるため、行数は確認しない）
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

  // 開き直すと結果が出て、「再送信…」で確認画面に戻る（送るのは「送信する」を押したとき）
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
  await expectHeaderLocked(page);
  // 頁を再読み込みするので、頁の HTML（描画の元のデータ・RSC の payload を含む）にも患者の値が残らない
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
  await expectHeaderLocked(page);

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
  // 解けば、上の帯の利用者・ログアウトが戻る
  await expect(page.getByTestId("current-user")).toContainText("e2e-admin（管理者）");
  await expect(page.getByTestId("site-header").getByRole("button", { name: "ログアウト" })).toBeVisible();
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
  // 確認しないので、成功しても失敗の数を消さない（docs/spec.md の 3.6）。この試験の誤りで閾値（3回）に近づきすぎないよう、
  // 先に TOTP まで確認するログインをし直して、数を0に戻す
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

  // 再読み込みしても、中身なしで描く（頁の HTML に患者の値が無い）
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
  // 解いたらロックの印は消え、再読み込みしても中身が出る
  await page.reload();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await page.close();
});

test("画面のロック：ロックの POST が届かず頁を読み直していなくても、上の帯に利用者・画面ロック・ログアウトを出さない", async () => {
  test.setTimeout(120_000);
  await admin.page.goto("about:blank");
  const page = await admin.context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("current-user")).toContainText("e2e-admin（管理者）");

  // POST を落とすので、頁は再読み込みされない（再読み込みした頁は BFF が利用者を渡さず、この確認にならない）
  await page.route("**/api/auth/lock", (route) => route.abort("internetdisconnected"));
  await page.getByRole("button", { name: "画面ロック", exact: true }).click();
  const lock = page.getByTestId("screen-lock");
  await expect(lock).toBeVisible();
  const header = page.getByTestId("site-header");
  await expect(header).toBeVisible();
  await expect(page.getByTestId("current-user")).toHaveCount(0);
  await expect(header).not.toContainText("e2e-admin");
  await expect(header.getByRole("button", { name: "ログアウト" })).toHaveCount(0);
  await expect(header.getByRole("button", { name: "画面ロック", exact: true })).toHaveCount(0);

  // 後の試験のために解く
  await page.unroute("**/api/auth/lock");
  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByRole("button", { name: "ロック解除" }).click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("current-user")).toContainText("e2e-admin（管理者）");
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
  // 知らせは届かないが、BFF の状態の確認（423）で閉じる
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

// フェーズ 5（検査の件数が 8 であることを見るほかの試験の後に置く。モックの Orthanc の中で1件を消すため）
test("段 5：管理者が書き出し（ZIP）を落とし、検査を理由と再認証つきで消す（確かめの画面は Orthanc から読み直した値）", async ({ browser }) => {
  test.setTimeout(120_000);
  // 新しくログインしたセッション（まだ再認証していない）で実行し、削除の前に必ず再認証を求められることを見る
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

  // 削除：確認画面（Orthanc から再取得した要点）→ 理由 → 再認証 → 消えた
  await page.getByTestId("delete-open").click();
  const panel = page.getByTestId("delete-panel");
  await expect(panel.getByTestId("delete-confirm")).toContainText("JP-TEST-0003");
  await expect(panel.getByTestId("delete-confirm")).toContainText("この操作は取り消せません");
  await expect(panel.getByTestId("delete-submit")).toBeDisabled();
  // 開いたら、最初の入力（削除の理由）へフォーカスが移る
  await expect(panel.getByTestId("delete-reason")).toBeFocused();
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
  // 消えると一覧を再取得し、その行（と詳細）は消える
  await expect(page.getByTestId("study-count")).toHaveText("7");
  await expect(page.locator(`tr[data-study-uid="${target}"]`)).toHaveCount(0);
  // 消したことは、一覧の上の知らせで示す（行も詳細も消えるため。docs/spec.md の 3.5・UX のレビューの H6）
  await expect(page.getByTestId("list-notice")).toContainText("検査を削除しました（JP-TEST-0003");

  // 一度通れば REAUTH_MINUTES（既定 5 分）の間は聞き直さない：続けて消すときは、理由と確認画面だけ
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

// 共有の管理者のセッションは、操作の無い時間が SCREEN_LOCK_MINUTES を越えるとロックされる。フェーズ 6 のように長い試験を挟む前に使い終える
test("ログアウトすると、セッションは使えない", async () => {
  const { page } = admin;
  await page.goto("/");
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/studies")).status()).toBe(401);
});

// フェーズ 6（フェーズ 5 の後に置く。モックの Orthanc の中で氏名を直し、検査を1件追加するため）
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

  // 患者情報修正：氏名（漢字）を直す → 確認（前と後の値・適用する範囲）→ 理由 → 再認証 → 修正しました
  await page.getByTestId("modify-open").click();
  const panel = page.getByTestId("modify-panel");
  await expect(panel.getByRole("tab", { name: "患者情報修正" })).toHaveAttribute("aria-selected", "true");
  // 確認欄の決まり（docs/design-system/parts.md）：開いたら最初の入力へフォーカス、キャンセルは左・実行は右、閉じたら開いたボタンへフォーカスを戻す
  await expect(panel.getByTestId("modify-PatientID")).toBeFocused();
  const cancelBox = (await panel.getByRole("button", { name: "キャンセル" }).first().boundingBox())!;
  const checkBox = (await panel.getByTestId("modify-attribute-check").boundingBox())!;
  expect(cancelBox.x).toBeLessThan(checkBox.x);
  await panel.getByRole("button", { name: "キャンセル" }).first().click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("modify-open")).toBeFocused();
  await page.getByTestId("modify-open").click();

  // 生年月日の欄は西暦と元号を受け、読み取り結果をその検査の検査日で数えて欄の下に出す（docs/spec.md の 3.1「生年月日の入力」）。
  // 確認画面へは YYYYMMDD で送る。確認した後に欄を元の値へ戻し、下の氏名の修正には混ぜない
  const birth = panel.getByTestId("modify-PatientBirthDate");
  await expect(birth).toHaveAttribute("type", "text");
  await expect(birth).toHaveAttribute("inputmode", "text");
  await expect(birth).toHaveAttribute("autocomplete", "off");
  const originalBirth = await birth.inputValue();
  const studyDate = /^(\d{4})\/(\d{2})\/(\d{2})/.exec((await page.locator(`tr[data-study-uid="${uid}"]`).getByTestId("study-datetime").getAttribute("title")) ?? "")!;
  const [sy, sm, sd] = [Number(studyDate[1]), Number(studyDate[2]), Number(studyDate[3])];
  const ageAtStudy = sy - 1975 - (sm < 5 || (sm === 5 && sd < 14) ? 1 : 0);
  await birth.fill("H31/05/01");
  await expect(panel.getByTestId("modify-PatientBirthDate-msg")).toHaveText("生年月日が平成の範囲にありません。平成は 2019/04/30 までです。令和1年は 2019/05/01 からです。");
  await expect(panel.getByTestId("modify-PatientBirthDate-hint")).toHaveCount(0);
  await expect(birth).toHaveAttribute("aria-invalid", "true");
  // 読めない入力のまま確認を押しても、要求を送らず欄へフォーカスを戻す
  await panel.getByTestId("modify-attribute-check").click();
  await expect(birth).toBeFocused();
  await expect(panel.getByTestId("modify-confirm")).toHaveCount(0);
  await birth.fill("S50/05/14");
  await expect(panel.getByTestId("modify-PatientBirthDate-hint")).toHaveText(`1975/05/14（昭50・${ageAtStudy}歳）`);
  await expect(panel.getByTestId("modify-PatientBirthDate-msg")).toHaveCount(0);
  await expect(birth).not.toHaveAttribute("aria-invalid");
  await expect(birth).toHaveAttribute("aria-describedby", (await panel.getByTestId("modify-PatientBirthDate-hint").getAttribute("id"))!);
  const previewSent = page.waitForRequest((r) => r.method() === "POST" && r.url().endsWith("/modify/preview"));
  await panel.getByTestId("modify-attribute-check").click();
  expect((await previewSent).postDataJSON().values).toEqual({ PatientBirthDate: "19750514" });
  await expect(panel.getByTestId("modify-confirm").getByTestId("modify-row-PatientBirthDate")).toContainText("1975/05/14");
  await birth.fill(originalBirth);
  await expect(panel.getByTestId("modify-confirm")).toHaveCount(0);

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

/** インポートの試験の SOP Instance UID の頭（合成。見本の検査の UID は 64 字あり、後ろに追加すると UI の上限 64 字を超える。PS3.5 6.2） */
const IMPORT_UID = "1.2.826.0.1.3680043.8.498.9905";

/** 試験のための合成の DICOM のファイル（PS3.10 の形。画素は入れない。値は合成で、実の患者のデータではない） */
function dicomBytes(o: { sop: string; study: string; patientId: string }): Buffer {
  const el = (group: number, element: number, vr: string, value: string) => {
    let v = Buffer.from(value, "latin1");
    if (v.length % 2) v = Buffer.concat([v, Buffer.from(vr === "UI" ? "\0" : " ", "latin1")]);
    const head = Buffer.alloc(8);
    head.writeUInt16LE(group, 0);
    head.writeUInt16LE(element, 2);
    head.write(vr, 4, "latin1");
    head.writeUInt16LE(v.length, 6);
    return Buffer.concat([head, v]);
  };
  const meta = Buffer.concat([
    el(0x0002, 0x0002, "UI", "1.2.840.10008.5.1.4.1.1.7"),
    el(0x0002, 0x0003, "UI", o.sop),
    el(0x0002, 0x0010, "UI", "1.2.840.10008.1.2.1"),
  ]);
  const groupLength = Buffer.alloc(12);
  groupLength.writeUInt16LE(0x0002, 0);
  groupLength.writeUInt16LE(0x0000, 2);
  groupLength.write("UL", 4, "latin1");
  groupLength.writeUInt16LE(4, 6);
  groupLength.writeUInt32LE(meta.length, 8);
  return Buffer.concat([
    Buffer.alloc(128),
    Buffer.from("DICM", "latin1"),
    groupLength,
    meta,
    el(0x0008, 0x0018, "UI", o.sop),
    el(0x0008, 0x0020, "DA", "20260410"),
    el(0x0008, 0x0060, "CS", "CT"),
    el(0x0010, 0x0010, "PN", "SHIKEN^IMPORT"),
    el(0x0010, 0x0020, "LO", o.patientId),
    el(0x0020, 0x000d, "UI", o.study),
    el(0x0020, 0x000e, "UI", `${o.sop.slice(0, o.sop.lastIndexOf("."))}`),
    el(0x0020, 0x0011, "IS", "1"),
    el(0x0020, 0x0013, "IS", o.sop.endsWith(".1") ? "1" : "2"),
  ]);
}

// フェーズ 6（フェーズ 5 の後に置く。フェーズ 5 で消した検査のファイルを入れ直す。モックの Orthanc は、見本の検査のファイルだけを受ける）
test("段 6：インポートは左のナビから開き、選んだファイルを 1 件ずつ送り、行の状態バッジに成功・失敗・対象外を出す。入れた検査は一覧で「インポート」と分かる", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const fresh = await newPage(browser);
  const { page } = fresh;
  await page.setViewportSize({ width: 1280, height: 900 });
  await submitLogin(page, E2E_ADMIN.username, ADMIN_PASSWORD);
  await expect(page).toHaveURL(/\/login\/totp$/);
  const totp = page.getByRole("form", { name: "認証" });
  await totp.getByLabel(/認証コード/).fill(await nextCode(adminSecret));
  await totp.getByRole("button", { name: "認証" }).click();
  await expect(page).toHaveURL(/\/$/);

  // フェーズ 5 で消した検査（JP-TEST-0003）。同じ組の 2 つのファイルで入れ直す
  const deleted = "1.2.826.0.1.3680043.8.498.74370219478963110549339491256573063606";
  await expect(page.locator(`tr[data-study-uid="${deleted}"]`)).toHaveCount(0);

  // 左のナビの業務の群の最後
  const nav = page.getByRole("navigation", { name: "ページ" });
  await nav.getByRole("link", { name: "インポート" }).click();
  await expect(page).toHaveURL(/\/import$/);
  await expect(page).toHaveTitle("インポート - tsunagi-dicom");
  await expect(nav.getByRole("link", { name: "インポート" })).toHaveAttribute("aria-current", "page");
  const picker = page.getByTestId("import");
  await expect(picker.getByTestId("import-formbar")).toHaveText("ファイルを選択してください。");
  await expect(picker.getByRole("button", { name: "インポート" })).toBeDisabled();

  await page.getByTestId("import-files").setInputFiles([
    { name: "IM0001", mimeType: "application/dicom", buffer: dicomBytes({ sop: `${IMPORT_UID}.1.1`, study: deleted, patientId: "JP-TEST-0003" }) },
    { name: "IM0002", mimeType: "application/dicom", buffer: dicomBytes({ sop: `${IMPORT_UID}.1.2`, study: deleted, patientId: "JP-TEST-0003" }) },
    // もう画像サーバーにある検査（消していない見本の検査）のファイル：BFF が断る
    { name: "IM0003", mimeType: "application/dicom", buffer: dicomBytes({ sop: `${IMPORT_UID}.2.1`, study: STUDY, patientId: "JP-TEST-0004" }) },
    { name: "memo.txt", mimeType: "text/plain", buffer: Buffer.from("DICOM ではないファイル") },
  ]);
  const rows = picker.getByTestId("import-row");
  await expect(rows).toHaveCount(4);
  await expect(picker.getByTestId("import-sum")).toContainText("4 件（対象外 1）");
  await expect(picker.getByTestId("import-sum")).toContainText("選択 3 件");
  // 対象外は一覧の上に、理由と状態バッジで残す（除外のボタンは無い）
  await expect(rows.first()).toContainText("memo.txt");
  await expect(rows.first()).toContainText("対象外");
  await expect(rows.first()).toContainText("DICOM ファイルではありません");
  await expect(rows.first().getByRole("button")).toHaveCount(0);
  // ブラウザで読んだ頭の値を列に出す
  const first = rows.filter({ hasText: "IM0001" });
  await expect(first).toContainText("JP-TEST-0003");
  await expect(first).toContainText("2026/04/10");
  await expect(first).toContainText("S1 / I1");

  // 除外と戻す：行に残り、焦点は同じ行のボタンに保つ
  const third = rows.filter({ hasText: "IM0003" });
  await third.getByRole("button", { name: "IM0003 を選択から除外" }).click();
  await expect(third).toContainText("除外");
  await expect(picker.getByTestId("import-sum")).toContainText("4 件（対象外 1・除外 1）");
  await expect(third.getByRole("button", { name: "IM0003 を選択に戻す" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(picker.getByTestId("import-sum")).toContainText("選択 3 件");
  await expect(third.getByRole("button", { name: "IM0003 を選択から除外" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("import-1280-selected.png"), fullPage: true });

  // インポート：選んだ順に 1 件ずつ送る。同じ組の ID・何番目か・件数を付ける
  const posts: Array<{ index: string | null; total: string | null; batch: string | null }> = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && new URL(r.url()).pathname === "/api/import") {
      posts.push({ index: r.headers()["x-import-index"] ?? null, total: r.headers()["x-import-total"] ?? null, batch: r.headers()["x-import-batch"] ?? null });
    }
  });
  await picker.getByRole("button", { name: "インポート" }).click();
  const result = picker.getByTestId("import-result");
  await expect(result).toHaveText(
    "選択 3 件のうち 2 件をインポートしました。1 件は失敗しました（理由は各行の状態）。",
  );
  await expect(result).toHaveAttribute("role", "alert");
  await expect(picker.getByTestId("import-formbar")).toHaveText("選択 3 件 → 成功 2・失敗 1");
  expect(posts.map((p) => [p.index, p.total])).toEqual([["1", "3"], ["2", "3"], ["3", "3"]]);
  expect(new Set(posts.map((p) => p.batch)).size).toBe(1);
  // 失敗が一覧の先頭。理由は BFF の誤りの最初の 1 文
  await expect(rows.first()).toContainText("IM0003");
  await expect(rows.first()).toContainText("失敗");
  await expect(rows.first()).toContainText("同じ画像または検査がもう画像サーバーにあります");
  await expect(rows.filter({ hasText: "IM0001" })).toContainText("成功");
  await expect(rows.filter({ hasText: "IM0002" })).toContainText("成功");
  // 終わった後は除外・戻すを出さず、「続けて選択」へ焦点を移す
  await expect(picker.getByRole("button", { name: /を選択から除外$/ })).toHaveCount(0);
  await expect(picker.getByRole("button", { name: "続けて選択" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("import-1280-done.png"), fullPage: true });

  // 同じファイルを入れ直すと、BFF が断る（取り込み直しで中身を置き換えない）
  await picker.getByRole("button", { name: "続けて選択" }).click();
  await expect(picker.getByRole("button", { name: "ファイルを選択" })).toBeFocused();
  await page.getByTestId("import-files").setInputFiles([
    { name: "IM0001", mimeType: "application/dicom", buffer: dicomBytes({ sop: `${IMPORT_UID}.1.1`, study: deleted, patientId: "JP-TEST-0003" }) },
  ]);
  await expect(picker.getByRole("button", { name: "インポート" })).toBeEnabled();
  await picker.getByRole("button", { name: "インポート" }).click();
  await expect(picker.getByTestId("import-formbar")).toHaveText("選択 1 件 → 成功 0・失敗 1");
  await expect(rows.first()).toContainText("同じ画像または検査がもう画像サーバーにあります");

  // 結果不明の状態バッジの出し方（画面だけを見る。BFF の答えを、画像サーバーの答えが分からなかった形に置き換える。
  // BFF の結果不明の扱いそのものは tests/unit/import-route.test.ts）：状態を 1 回確認し、決まらなければ結果不明
  let checks = 0;
  await page.route("**/api/import*", async (route) => {
    const unknown = { outcome: "unknown", studyInstanceUid: deleted, error: "インポートの結果を確認できません。状態を確認してください" };
    if (route.request().method() === "GET") checks++;
    await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify(unknown) });
  });
  await picker.getByRole("button", { name: "続けて選択" }).click();
  await page.getByTestId("import-files").setInputFiles([
    { name: "IM0004", mimeType: "application/dicom", buffer: dicomBytes({ sop: `${IMPORT_UID}.3.1`, study: deleted, patientId: "JP-TEST-0003" }) },
  ]);
  await expect(picker.getByRole("button", { name: "インポート" })).toBeEnabled();
  await picker.getByRole("button", { name: "インポート" }).click();
  await expect(picker.getByTestId("import-formbar")).toHaveText("選択 1 件 → 成功 0・失敗 0・結果不明 1");
  expect(checks).toBe(1);
  await expect(rows.first()).toContainText("結果不明");
  await expect(rows.first().locator("[data-k=unknown]")).toHaveCount(1);
  await expect(rows.first()).toContainText("画像サーバーに入ったか分かりません");
  await expect(result).toHaveText(
    // 管理者（結果不明を照らせる役割）には「管理者に確かめを頼んでください。」を添えない
    "選択 1 件のうち 0 件をインポートしました。1 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。",
  );
  await page.screenshot({ path: testInfo.outputPath("import-1280-unknown.png"), fullPage: true });

  // 結果不明を管理者が確認して記録する（parts.md の「結果不明を確認する」）。「確認」は識別子を持つ結果不明の行だけ
  const unknownRow = rows.first();
  const resolvePanel = page.getByTestId("import-resolve");
  await expect(resolvePanel).toHaveCount(0);
  await unknownRow.getByRole("button", { name: "IM0004 の結果不明を確認" }).click();
  await expect(resolvePanel).toBeVisible();
  await expect(resolvePanel.getByRole("heading", { name: "結果不明の確認" })).toBeVisible();
  await expect(resolvePanel).toContainText("IM0004");
  await expect(resolvePanel).toContainText(deleted);
  await expect(resolvePanel.getByTestId("import-resolve-input")).toBeFocused();
  await expect(resolvePanel.getByTestId("import-resolve-input")).toHaveAttribute("aria-required", "true");
  // 主ボタンは置かない。確認内容が空のまま押すと、欄の下に誤りを出して欄へ焦点を戻す（BFF は呼ばない）
  await expect(resolvePanel.locator("button.bg-primary")).toHaveCount(0);
  await resolvePanel.getByRole("button", { name: "成功として記録" }).click();
  await expect(resolvePanel.getByTestId("import-resolve-note-msg")).toHaveText("確認内容を入力してください。");
  await expect(resolvePanel.getByTestId("import-resolve-input")).toBeFocused();
  await expect(unknownRow).toContainText("結果不明");
  await page.screenshot({ path: testInfo.outputPath("import-1280-resolve.png"), fullPage: true });
  // BFF が断ったとき：欄を閉じず、欄の上に BFF の文を出し、入力と状態バッジはそのまま（この要求は BFF に記録が無いので 404）
  await resolvePanel.getByTestId("import-resolve-input").fill("画像サーバーで確認した");
  await resolvePanel.getByRole("button", { name: "失敗として記録" }).click();
  await expect(resolvePanel.getByTestId("import-resolve-error")).toHaveText("この検査に、その要求ID のインポートはありません");
  await expect(resolvePanel.getByTestId("import-resolve-error")).toHaveAttribute("role", "alert");
  await expect(resolvePanel.getByTestId("import-resolve-input")).toHaveValue("画像サーバーで確認した");
  await expect(unknownRow).toContainText("結果不明");
  // BFF が受けたとき：欄を閉じ、状態バッジは成功に替わって「管理者が確認」、件数を数え直し、知らせは結果不明の文を外す。焦点は「続けて選択」
  let resolveBody: { requestId?: unknown; outcome?: unknown; note?: unknown } | null = null;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/studies/*/import/resolve", async (route) => {
    resolveBody = route.request().postDataJSON() as typeof resolveBody;
    await gate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ outcome: "stored", instancePresent: true }) });
  });
  await resolvePanel.getByRole("button", { name: "成功として記録" }).click();
  // 記録を送っている間は、3 つのボタンと「続けて選択」を押せない
  await expect(resolvePanel.getByRole("button", { name: "成功として記録" })).toBeDisabled();
  await expect(picker.getByRole("button", { name: "続けて選択" })).toBeDisabled();
  release();
  await expect(resolvePanel).toHaveCount(0);
  expect(resolveBody).toMatchObject({ outcome: "success", note: "画像サーバーで確認した" });
  expect(typeof (resolveBody as { requestId?: unknown } | null)?.requestId).toBe("string");
  await expect(rows.first()).toContainText("IM0004");
  await expect(rows.first()).toContainText("成功");
  await expect(rows.first()).toContainText("管理者が確認");
  await expect(rows.first().getByRole("button", { name: /結果不明を確認$/ })).toHaveCount(0);
  await expect(picker.getByTestId("import-formbar")).toHaveText("選択 1 件 → 成功 1・失敗 0");
  await expect(result).toHaveText("選択 1 件のうち 1 件はインポート済みです（うち 1 件は管理者が確認）。");
  // 読み上げは隠した領域に 1 回だけ。記録したあとの知らせには role を付けない
  await expect(result).not.toHaveAttribute("role", /.+/);
  await expect(page.getByTestId("import-live")).toHaveText("IM0004 を成功として記録しました。");
  await expect(picker.getByRole("button", { name: "続けて選択" })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("import-1280-resolved.png"), fullPage: true });
  await page.unroute("**/api/studies/*/import/resolve");
  await page.unroute("**/api/import*");

  // 入れた検査は、検査一覧に戻り、「インポート」の印で分かる
  await nav.getByRole("link", { name: "検査一覧" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(`tr[data-study-uid="${deleted}"]`).getByTestId("study-imported")).toHaveText(/インポート/);
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

  // 再読み込みしたロックの画面（BFF が中身なしで描いた頁）からも出られる（CSRF の token が頁に渡っている）
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
