import { expect, test } from "@playwright/test";
import { BACKEND_PASSWORD_MARKER } from "../../playwright.config";

test.describe("共通の画面と検査の一覧（モック）", () => {
  test("暗い地の頁に「非医療機器」の表示と、モックの検査の件数・一覧が出る", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByTestId("not-for-diagnostic-use")).toHaveText("Not for Diagnostic Use / 非医療機器");
    await expect(page.getByTestId("study-count")).toHaveText("8");

    const rows = page.getByTestId("study-table").locator("tbody tr");
    await expect(rows).toHaveCount(8);
    await expect(page.getByTestId("study-table")).toContainText("JP-TEST-0001");
    await expect(page.getByTestId("study-table")).toContainText("Yamada^Taro=山田^太郎=やまだ^たろう");

    const body = page.locator("body");
    await expect(body).toHaveCSS("background-color", "rgb(18, 20, 23)");
    await expect(body).toHaveCSS("font-size", "14px");
    await expect(body).toHaveCSS("color", "rgb(230, 237, 243)");
  });

  test("API の中継は資格情報を返さない", async ({ page, request }) => {
    await page.goto("/");
    expect(await page.content()).not.toContain(BACKEND_PASSWORD_MARKER);

    for (const url of ["/api/studies", "/api/dicom-web/studies"]) {
      const res = await request.get(url);
      expect(res.status()).toBe(200);
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
});

test.describe("検証モード（AUTH_MODE=dev）", () => {
  test("画面の上に「検証モード」の帯と役割の切り替えが出る", async ({ page }) => {
    await page.goto("/");
    const band = page.getByTestId("dev-mode-band");
    await expect(band).toContainText("検証モード");
    await expect(band).toContainText("書き込みは止めている");
    for (const label of ["管理者", "医師", "技師", "閲覧"]) {
      await expect(band.getByRole("button", { name: label })).toBeVisible();
    }
    // 役割を選んでいなければ「閲覧」
    await expect(band.getByRole("button", { name: "閲覧" })).toHaveAttribute("aria-pressed", "true");
  });

  test("役割を切り替えると画面に反映し、切り替えを監査の記録に残す", async ({ page }) => {
    await page.goto("/");
    const band = page.getByTestId("dev-mode-band");

    // 閲覧では監査の確かめを使えない
    expect((await page.request.get("/api/audit/verify")).status()).toBe(403);

    await band.getByRole("button", { name: "管理者" }).click();
    await expect(band.getByRole("button", { name: "管理者" })).toHaveAttribute("aria-pressed", "true");
    await expect(band.getByRole("button", { name: "閲覧" })).toHaveAttribute("aria-pressed", "false");

    const before = await (await page.request.get("/api/audit/verify")).json();
    expect(before.ok).toBe(true);

    await band.getByRole("button", { name: "医師" }).click();
    await expect(band.getByRole("button", { name: "医師" })).toHaveAttribute("aria-pressed", "true");
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
    await expect(page.getByTestId("dev-mode-band").getByRole("button", { name: "閲覧" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect((await page.request.get("/api/audit/verify")).status()).toBe(403);
  });

  test("書き込みの要求は止まる（DEV_ALLOW_WRITE が無いとき）", async ({ page, request }) => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await request.fetch("/api/dicom-web/studies", {
        method,
        headers: { "content-type": "application/dicom" },
        data: Buffer.from("not really dicom"),
      });
      expect(res.status(), method).toBe(403);
      expect((await res.json()).error).toContain("DEV_ALLOW_WRITE=true");
    }

    // 止めたことも監査の記録に残り、つなぎは壊れていない
    await page.goto("/");
    await page.getByTestId("dev-mode-band").getByRole("button", { name: "管理者" }).click();
    await expect(page.getByTestId("dev-mode-band").getByRole("button", { name: "管理者" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect((await (await page.request.get("/api/audit/verify")).json()).ok).toBe(true);
  });
});
