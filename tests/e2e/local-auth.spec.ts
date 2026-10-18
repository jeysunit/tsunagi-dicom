import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { totpAt, totpStep } from "../../src/lib/auth/totp";
import { E2E_ADMIN, LOCAL_BASE_URL } from "../../playwright.config";

// AUTH_MODE=local（段 1b）：ログイン・パスワードの規則・TOTP・ログインの一時停止・画面のロック・利用者の棚卸し・役割。
// サーバーは LOGIN_LOCK_THRESHOLD=3・LOGIN_LOCK_MINUTES=1・SCREEN_LOCK_MINUTES=1・MFA_REQUIRED=true（playwright.config.ts）。
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
  await form.getByLabel("利用者名").fill(username);
  await form.getByLabel("パスワード").fill(password);
  await form.getByRole("button", { name: "ログイン" }).click();
}

/** 登録の頁で秘密を読み、確認の番号で登録する */
async function enrollTotp(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/login\/enroll$/);
  await expect(page.getByTestId("totp-qr")).toBeVisible();
  const secret = (await page.getByTestId("totp-secret").getAttribute("data-secret"))!;
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  const form = page.getByRole("form", { name: "登録する" });
  await form.getByLabel(/確認の番号/).fill(await nextCode(secret));
  await form.getByRole("button", { name: "登録する" }).click();
  return secret;
}

async function changeOwnPassword(page: Page, password: string) {
  await expect(page).toHaveURL(/\/login\/password$/);
  const form = page.getByRole("form", { name: "パスワードの変更" });
  await form.locator('input[name="newPassword"]').fill(password);
  await form.locator('input[name="confirm"]').fill(password);
  await form.getByRole("button", { name: "パスワードを変える" }).click();
}

/** 検査の一覧の1行目の、患者 ID・氏名・StudyInstanceUID（合成の見本の値） */
async function patientValues(page: Page): Promise<string[]> {
  const row = page.getByTestId("study-table").locator("tbody tr").first();
  const values = [
    (await row.locator("td").nth(1).innerText()).trim(),
    (await row.locator("td").nth(2).innerText()).trim(),
    (await row.getAttribute("data-study-uid")) ?? "",
  ];
  for (const v of values) expect(v.length).toBeGreaterThan(3);
  return values;
}

/** 頁の HTML（描画の元のデータを含む）に、患者の値が無い（読み直しの後） */
async function expectNoPatientValues(page: Page, values: string[]) {
  await expect
    .poll(async () => {
      const html = await page.content();
      return values.filter((v) => html.includes(v));
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
  await expect(page.getByTestId("not-for-diagnostic-use")).toBeVisible();
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
    ["onlyletters", "英字と数字を両方含める"],
  ] as const) {
    await form.locator('input[name="newPassword"]').fill(bad);
    await form.locator('input[name="confirm"]').fill(bad);
    await form.locator('input[name="newPassword"]').evaluate((el) => el.removeAttribute("minlength"));
    await form.getByRole("button", { name: "パスワードを変える" }).click();
    await expect(form.getByRole("alert")).toContainText(reason);
  }
  await changeOwnPassword(page, ADMIN_PASSWORD);

  await expect(page).toHaveURL(`${LOCAL_BASE_URL}/`);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("current-user")).toContainText("e2e-admin・管理者");
  expect((await (await page.request.get("/api/audit/verify")).json()).ok).toBe(true);
});

test("利用者の棚卸し：一覧に最後のログインを出し、管理者が利用者を作り、役割を変える（大事な操作の前に再認証）", async () => {
  test.setTimeout(90_000);
  const { page } = admin;
  await page.goto("/admin/users");
  const table = page.getByTestId("user-table");
  const adminRow = table.locator(`tr[data-username="${E2E_ADMIN.username}"]`);
  await expect(adminRow).toContainText("登録あり");
  await expect(adminRow.getByTestId("last-login")).not.toHaveText("まだ無い");

  const form = page.getByRole("form", { name: "利用者を作る" });
  // 規則に合わない最初のパスワードは断る
  await form.locator('input[name="username"]').fill(DOCTOR.username);
  await form.getByLabel("表示の名前").fill("試験 医師");
  await form.locator('select[name="role"]').selectOption("viewer");
  await form.locator('input[name="password"]').fill("qwerty123");
  await form.getByRole("button", { name: "作る" }).click();

  // 利用者の管理は大事な操作なので、BFF が再認証を求める。違うパスワードでは通らない
  const reauth = page.getByRole("form", { name: "本人の確かめ" });
  await expect(reauth).toBeVisible();
  await reauth.locator('input[name="password"]').fill("wrong-Pass-1x");
  await reauth.locator('input[name="code"]').fill("000000");
  await reauth.getByRole("button", { name: "確かめて続ける" }).click();
  await expect(reauth.getByRole("alert")).toContainText("違う");
  await reauth.locator('input[name="password"]').fill(ADMIN_PASSWORD);
  await reauth.locator('input[name="code"]').fill(await nextCode(adminSecret));
  await reauth.getByRole("button", { name: "確かめて続ける" }).click();
  await expect(reauth).toHaveCount(0);
  // 通ったら同じ操作をもう一度送る（ここでは規則に合わない最初のパスワードで断られる）
  await expect(page.getByRole("main").getByRole("alert")).toContainText("よく使われる");

  await form.locator('input[name="password"]').fill(DOCTOR.initial);
  await form.getByRole("button", { name: "作る" }).click();
  await expect(page.getByRole("main").getByRole("status")).toContainText("利用者を作った");
  const row = table.locator(`tr[data-username="${DOCTOR.username}"]`);
  await expect(row.getByTestId("last-login")).toHaveText("まだ無い");

  // 役割の変更（閲覧 → 医師）
  await row.getByLabel(`${DOCTOR.username} の役割`).selectOption("doctor");
  await expect(page.getByRole("main").getByRole("status")).toContainText("役割を医師にした");
  await page.reload();
  await expect(table.locator(`tr[data-username="${DOCTOR.username}"]`).getByLabel(`${DOCTOR.username} の役割`)).toHaveValue(
    "doctor",
  );

  // ログインの一時停止の試験に使う利用者
  await form.locator('input[name="username"]').fill(LOCKED.username);
  await form.getByLabel("表示の名前").fill("試験 一時停止");
  await form.locator('input[name="password"]').fill(LOCKED.initial);
  await form.getByRole("button", { name: "作る" }).click();
  await expect(table.locator(`tr[data-username="${LOCKED.username}"]`)).toBeVisible();

  const list = await (await page.request.get("/api/admin/users")).json();
  expect(JSON.stringify(list)).not.toMatch(/argon2id|passwordHash|totpSecret/);
});

test("役割ごとにできる操作：医師は検査と画像を見られ、利用者の管理と監査の確かめはできない", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, page } = await newPage(browser);
  await submitLogin(page, DOCTOR.username, DOCTOR.initial);
  await enrollTotp(page);
  await changeOwnPassword(page, DOCTOR.password);
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("current-user")).toContainText("e2e-doctor・医師");
  await expect(page.getByRole("link", { name: "利用者" })).toHaveCount(0);

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
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("管理者だけが開ける");
  await context.close();
});

test("CSRF の対策：token の無い要求・別の Origin の要求は断る", async () => {
  const { page } = admin;
  await page.goto("/");
  const origin = LOCAL_BASE_URL;
  const noToken = await page.request.post("/api/auth/lock", { headers: { origin }, data: { reason: "manual" } });
  expect(noToken.status()).toBe(403);
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

test("ログインの一時停止：3回続けて失敗したら、正しいパスワードでも止める。管理者は解ける", async ({ browser }) => {
  const { context, page } = await newPage(browser);
  for (let i = 0; i < 3; i++) {
    await submitLogin(page, LOCKED.username, `wrong-Pass-${i}x9`);
    await expect(page.getByRole("main").getByRole("alert")).toContainText("利用者名かパスワード");
  }
  await submitLogin(page, LOCKED.username, LOCKED.initial);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("しばらくログインを止めている");
  await expect(page).toHaveURL(/\/login$/);

  // 管理者の一覧に一時停止が出て、解ける
  await admin.page.goto("/admin/users");
  const row = admin.page.getByTestId("user-table").locator(`tr[data-username="${LOCKED.username}"]`);
  await expect(row).toContainText("一時停止");
  await row.getByRole("button", { name: "一時停止を解く" }).click();
  await expect(admin.page.getByRole("main").getByRole("status")).toContainText("一時停止を解いた");

  await submitLogin(page, LOCKED.username, LOCKED.initial);
  await expect(page).toHaveURL(/\/login\/enroll$/);
  await context.close();
});

test("画面のロック：操作の無い時間が続いたら画面をぼかしてロックし、パスワードと TOTP で解く", async () => {
  test.setTimeout(120_000);
  const { page } = admin;
  await page.clock.install();
  await page.goto("/");
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(page.getByTestId("screen-lock")).toHaveCount(0);
  const patient = await patientValues(page);

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
  // サーバーの側もロックしている：画面の API と中継は 423、開き直しても中身を描かない
  await expect.poll(async () => (await page.request.get("/api/studies")).status()).toBe(423);
  expect((await page.request.get(`/api/dicom-web/studies/${STUDY}/metadata`)).status()).toBe(423);
  await page.reload();
  await expect(page.getByTestId("screen-lock")).toBeVisible();
  await expect(page.getByTestId("study-count")).toHaveCount(0);

  // パスワードだけ・違う番号では解けない
  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByLabel(/確認の番号/).fill("000000");
  await lock.getByRole("button", { name: "ロックを解く" }).click();
  await expect(lock.getByRole("alert")).toContainText("違う");

  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByLabel(/確認の番号/).fill(await nextCode(adminSecret));
  await lock.getByRole("button", { name: "ロックを解く" }).click();
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

  await page.getByRole("button", { name: "ロック", exact: true }).click();
  await expect(page.getByTestId("screen-lock")).toBeVisible();
  await expect(other.getByTestId("screen-lock")).toBeVisible();
  await expectNoPatientValues(page, patient);
  await expectNoPatientValues(other, patient);

  // 1つのタブで解けば、ほかのタブも戻る
  const lock = page.getByTestId("screen-lock");
  await lock.getByLabel("パスワード").fill(ADMIN_PASSWORD);
  await lock.getByLabel(/確認の番号/).fill(await nextCode(adminSecret));
  await lock.getByRole("button", { name: "ロックを解く" }).click();
  await expect(page.getByTestId("study-count")).toHaveText("8");
  await expect(other.getByTestId("study-count")).toHaveText("8");
  await other.close();
});

test("ログアウトすると、セッションは使えない", async () => {
  const { page } = admin;
  await page.goto("/");
  await page.getByRole("button", { name: "ログアウト" }).click();
  await expect(page).toHaveURL(/\/login$/);
  expect((await page.request.get("/api/studies")).status()).toBe(401);
});
