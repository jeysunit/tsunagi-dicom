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
    // 生年月日は和暦・検査日の時点の年齢・性別を添える
    await expect(table).toContainText("1975/05/10（昭和50年・51歳・男）");

    const body = page.locator("body");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(body).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(body).toHaveCSS("font-size", "14px");
    await expect(body).toHaveCSS("color", "rgb(31, 35, 40)");
  });

  test("暗い地に切り替えると、利用者ごとに覚えて、開き直しても暗い地のまま", async ({ page }) => {
    await page.goto("/");
    const toggle = page.getByTestId("theme-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");

    const saved = page.waitForResponse((r) => r.url().endsWith("/api/preferences/theme") && r.ok());
    await toggle.click();
    await saved;
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(18, 20, 23)");
    await expect(page.locator("body")).toHaveCSS("color", "rgb(230, 237, 243)");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute("aria-pressed", "true");

    // 次の試験のために明るい地へ戻す
    const back = page.waitForResponse((r) => r.url().endsWith("/api/preferences/theme") && r.ok());
    await page.getByTestId("theme-toggle").click();
    await back;
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
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
