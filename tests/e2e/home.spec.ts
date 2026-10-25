import { expect, test } from "@playwright/test";
import { BACKEND_PASSWORD_MARKER } from "../../playwright.config";

/** 見本の1件目の検査の StudyInstanceUID */
const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";

test.describe("共通の画面と検査の一覧（モック）", () => {
  test("明るい地の頁に、モックの検査の件数・一覧が出る（「非医療機器」の表示は出さない）", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("not-for-diagnostic-use")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText("非医療機器");
    await expect(page.getByTestId("study-count")).toHaveText("8");

    const rows = page.getByTestId("study-table").locator("tbody tr");
    await expect(rows).toHaveCount(8);
    const table = page.getByTestId("study-table");
    await expect(table).toContainText("JP-TEST-0001");
    // 氏名は漢字とかなに分け、PN の元の形（^ と =）は出さない
    await expect(table).toContainText("山田 太郎");
    await expect(table).toContainText("やまだ たろう");
    await expect(table).not.toContainText("Yamada^Taro");
    // 生年月日・検査日の時点の年齢・性別は3つの列（和暦は生年月日の title。docs/spec.md の 3.1）
    const yamada = table.locator("tbody tr", { hasText: "JP-TEST-0001" }).first();
    await expect(yamada.getByTestId("patient-birth")).toHaveText("1975/05/10");
    await expect(yamada.getByTestId("patient-birth")).toHaveAttribute("title", "1975/05/10（昭和50年）");
    await expect(yamada.getByTestId("patient-age")).toHaveText("51歳");
    await expect(yamada.getByTestId("patient-sex")).toHaveText("男");

    const body = page.locator("body");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(body).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(body).toHaveCSS("font-size", "14px");
    await expect(body).toHaveCSS("color", "rgb(38, 38, 38)");
  });

  test("暗い地に切り替えると、利用者ごとに覚えて、開き直しても暗い地のまま", async ({ page }) => {
    // 期待の変更：切り替えは、絵の押しボタン 1 つ（aria-label「明るい地と暗い地を切り替える」）にした。押している状態（aria-pressed）が暗い地。
    // 前は「表示」のライト・ダークの 2 つのボタンだった。押すたびに替える
    await page.goto("/");
    const toggle = page.getByRole("button", { name: "明るい地と暗い地を切り替える" });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    const saved = page.waitForResponse((r) => r.url().endsWith("/api/preferences/theme") && r.ok());
    await toggle.click();
    await saved;
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(27, 27, 27)");
    await expect(page.locator("body")).toHaveCSS("color", "rgb(232, 232, 232)");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // 次の試験のために明るい地へ戻す
    const back = page.waitForResponse((r) => r.url().endsWith("/api/preferences/theme") && r.ok());
    await toggle.click();
    await back;
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("上の帯：製品名の横に版、接続の状態の札と標準の popover、見出しの h1", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("検査一覧");
    const header = page.getByTestId("site-header");
    await expect(header.getByTestId("app-version")).toHaveText(/^\d+\.\d+\.\d+/);
    const button = header.getByRole("button", { name: "接続の状態を開く" });
    // 札は全体の状態 1 つ（接続中・一部が接続不可）。ほかの試験で接続確認が失敗していれば後者になる
    await expect(button).toContainText(/接続中|一部が接続不可/);
    const pop = page.getByTestId("conn-popover");
    await expect(pop).toBeHidden();

    // キーボードだけで開き、中の道へ進み、Esc で閉じて元のボタンへ戻る
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(pop).toBeVisible();
    await expect(pop).toContainText("画像サーバー（Orthanc）");
    await expect(pop).toContainText("HL7 の受け口");
    await expect(pop.getByTestId("backend-mock")).toHaveText("バックエンド：モック");
    await page.keyboard.press("Tab");
    await expect(pop.getByRole("link", { name: "接続先を開く" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(pop).toBeHidden();
    await expect(button).toBeFocused();

    // 低い画面でも、中でスクロールして末尾の道まで届く（popover の高さは、ボタンの下から画面の下端まで）
    await page.setViewportSize({ width: 1024, height: 260 });
    await page.keyboard.press("Enter");
    await expect(pop).toBeVisible();
    const link = pop.getByRole("link", { name: "接続先を開く" });
    await link.scrollIntoViewIfNeeded();
    await expect(link).toBeInViewport();
    expect((await pop.boundingBox())!.y + (await pop.boundingBox())!.height).toBeLessThanOrEqual(260);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1280, height: 720 });

    // 外を押しても閉じる。「接続先を開く」を押すと接続先の頁へ移り、popover は閉じる
    await button.click();
    await expect(pop).toBeVisible();
    await page.getByRole("heading", { level: 1 }).click();
    await expect(pop).toBeHidden();
    await button.click();
    await pop.getByRole("link", { name: "接続先を開く" }).click();
    await expect(page).toHaveURL(/\/modalities$/);
    await expect(pop).toBeHidden();
  });

  test("地の色の保存は、別の場所からの要求と、決めた値の外を断る", async ({ request }) => {
    const foreign = await request.post("/api/preferences/theme", {
      data: { theme: "dark" },
      headers: { origin: "https://attacker.example.org" },
    });
    expect(foreign.status()).toBe(403);
    const bad = await request.post("/api/preferences/theme", {
      data: { theme: "<script>" },
      headers: { origin: "http://127.0.0.1:3100" },
    });
    expect(bad.status()).toBe(400);
  });

  test("API の中継は資格情報を返さない", async ({ page, request }) => {
    await page.goto("/");
    expect(await page.content()).not.toContain(BACKEND_PASSWORD_MARKER);

    for (const url of ["/api/studies", `/api/dicom-web/studies/${STUDY}/metadata`]) {
      const res = await request.get(url);
      expect(res.status(), url).toBe(url === "/api/studies" ? 200 : 404);
      const text = await res.text();
      expect(text).not.toContain(BACKEND_PASSWORD_MARKER);
      expect(text).not.toContain("e2e-user");
    }
    const studies = await (await request.get("/api/studies")).json();
    expect(studies.count).toEqual({ count: 8, exact: true });
    expect(studies.studies).toHaveLength(8);
  });

  test("中継は見本の外へ出る path を断る", async ({ request }) => {
    const res = await request.get("/api/dicom-web/studies/..%2F..%2Frest/system.json");
    expect([400, 404]).toContain(res.status());
  });

  test("中継は検索（QIDO-RS）を返さない：検索は画面の API を通す", async ({ request }) => {
    for (const path of ["studies", "studies?PatientID=JP-TEST-0001", `studies/${STUDY}/series`]) {
      const res = await request.get(`/api/dicom-web/${path}`);
      expect(res.status(), path).toBe(404);
      const body = await res.json();
      expect(body.error).toContain("WADO-RS の読み取りだけ");
      expect(JSON.stringify(body)).not.toContain("JP-TEST-");
    }
  });

  test("中継は WADO-RS の読み取りを通し、取得を監査の記録に残す", async ({ page }) => {
    await page.goto("/");
    const band = page.getByTestId("dev-mode-band");
    await band.getByRole("button", { name: "管理者" }).click();
    await expect(band.getByRole("button", { name: "管理者" })).toHaveAttribute("aria-pressed", "true");

    const before = await (await page.request.get("/api/audit/verify")).json();
    // モックには WADO-RS の見本が無いので 404 だが、宛先の確かめは通って画像サーバー（モック）まで届く
    const res = await page.request.get(`/api/dicom-web/studies/${STUDY}/series/1.2.826.0.1.3680043.8.498.1/metadata`);
    expect(res.status()).toBe(404);
    expect((await res.json()).error).toBe("見本に無い");
    const after = await (await page.request.get("/api/audit/verify")).json();
    expect(after.ok).toBe(true);
    expect(after.checked).toBe(before.checked + 1);
  });
});

test.describe("検証モード（AUTH_MODE=dev）", () => {
  test("画面の上に「検証モード」の帯と役割の切り替えが出る", async ({ page }) => {
    await page.goto("/");
    const band = page.getByTestId("dev-mode-band");
    await expect(band).toContainText("検証モード");
    // 文言は docs/spec.md の 2.2 の用語集（書き込みは止めている→書き込み：無効）
    await expect(band).toContainText("書き込み：無効");
    // 役割は管理者と一般の2つ（2026-10-20。docs/spec.md の 3.6・4）。前の医師・技師・閲覧のボタンは無い
    for (const label of ["管理者", "一般"]) {
      await expect(band.getByRole("button", { name: label })).toBeVisible();
    }
    for (const label of ["医師", "技師", "閲覧"]) await expect(band.getByRole("button", { name: label })).toHaveCount(0);
    // 役割を選んでいなければ「一般」（狭いほう）
    await expect(band.getByRole("button", { name: "一般" })).toHaveAttribute("aria-pressed", "true");
  });

  test("役割を切り替えると画面に反映し、切り替えを監査の記録に残す", async ({ page }) => {
    await page.goto("/");
    const band = page.getByTestId("dev-mode-band");

    // 一般では監査の確かめを使えない
    expect((await page.request.get("/api/audit/verify")).status()).toBe(403);

    await band.getByRole("button", { name: "管理者" }).click();
    await expect(band.getByRole("button", { name: "管理者" })).toHaveAttribute("aria-pressed", "true");
    await expect(band.getByRole("button", { name: "一般" })).toHaveAttribute("aria-pressed", "false");

    const before = await (await page.request.get("/api/audit/verify")).json();
    expect(before.ok).toBe(true);

    await band.getByRole("button", { name: "一般" }).click();
    await expect(band.getByRole("button", { name: "一般" })).toHaveAttribute("aria-pressed", "true");
    await band.getByRole("button", { name: "管理者" }).click();
    await expect(band.getByRole("button", { name: "管理者" })).toHaveAttribute("aria-pressed", "true");

    const after = await (await page.request.get("/api/audit/verify")).json();
    expect(after.ok).toBe(true);
    // 2回の切り替えと、そのたびの頁の描き直し（検索）が足されている
    expect(after.checked).toBeGreaterThanOrEqual(before.checked + 2);
  });

  test("署名の無い役割の cookie は使わない", async ({ page, context }) => {
    await context.addCookies([{ name: "tsunagi_dev_role", value: "admin.forged", url: "http://127.0.0.1:3100" }]);
    await page.goto("/");
    await expect(page.getByTestId("dev-mode-band").getByRole("button", { name: "一般" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect((await page.request.get("/api/audit/verify")).status()).toBe(403);
  });

  test("中継への書き込みの要求は止まる（中継には書き込みの道を作らない）", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("dev-mode-band").getByRole("button", { name: "管理者" }).click();
    await expect(page.getByTestId("dev-mode-band").getByRole("button", { name: "管理者" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const before = await (await page.request.get("/api/audit/verify")).json();

    const methods = ["POST", "PUT", "PATCH", "DELETE"] as const;
    for (const method of methods) {
      const res = await page.request.fetch("/api/dicom-web/studies", {
        method,
        headers: { "content-type": "application/dicom" },
        data: Buffer.from("not really dicom"),
      });
      expect(res.status(), method).toBe(405);
      expect(res.headers()["allow"]).toBe("GET, HEAD");
      // 段 4 で書き込みの操作（送る）が画面の API にできたので、文言を「中継では受けない」に変えた
      expect((await res.json()).error).toContain("書き込みは中継では受けない");
    }

    // 止めたことも監査の記録に残り、つなぎは壊れていない
    const after = await (await page.request.get("/api/audit/verify")).json();
    expect(after.ok).toBe(true);
    expect(after.checked).toBe(before.checked + methods.length);
  });

  test("役割の切り替えの本文が大きすぎれば断る", async ({ request }) => {
    const res = await request.post("/api/dev/role", { data: { role: "admin", pad: "x".repeat(4096) } });
    expect(res.status()).toBe(413);
  });
});
