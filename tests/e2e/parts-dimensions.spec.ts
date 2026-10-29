import { expect, test, type Locator, type Page } from "@playwright/test";

// 部品の主な寸法を、部品集（docs/design-system/parts.md。ui-kit 1.2.0 の components.css）の値と比べる（部品集 delivery.md の C4）。
// 上の帯の写し（1280 幅の上の帯と左のナビ）は、撮るだけで比べない。検証モード（AUTH_MODE=dev）とモックに対して流す。

async function asAdmin(page: Page) {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: "管理者" });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

const styleOf = (loc: Locator, props: string[]) =>
  loc.evaluate((el, names) => {
    const s = getComputedStyle(el) as unknown as Record<string, string>;
    return Object.fromEntries(names.map((n) => [n, s[n]!]));
  }, props);

test.describe("部品の寸法", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("上の帯：ナビの開閉は 32px で Menu の絵、接続の状態は枠つき 32px。札は高さ 20px・角 3px", async ({ page }) => {
    await asAdmin(page);
    const toggle = page.getByTestId("nav-toggle");
    const box = (await toggle.boundingBox())!;
    expect(Math.round(box.width)).toBe(32);
    expect(Math.round(box.height)).toBe(32);
    await expect(toggle).toHaveAttribute("aria-controls", "sidenav");
    await expect(toggle).toHaveAccessibleName("ナビを開閉する");
    await expect(page.locator("#sidenav")).toHaveCount(1);
    const before = await toggle.innerHTML();
    await toggle.click();
    expect(await toggle.innerHTML()).toBe(before);
    await expect(toggle).toHaveAccessibleName("ナビを開閉する");
    await expect(toggle).toHaveAttribute("title", "ナビを開く");
    await toggle.click();

    const conn = page.getByTestId("conn-button");
    const connBox = (await conn.boundingBox())!;
    expect(Math.round(connBox.height)).toBe(32);
    expect(await styleOf(conn, ["borderTopWidth", "borderTopLeftRadius"])).toEqual({ borderTopWidth: "1px", borderTopLeftRadius: "4px" });
    const label = conn.getByText("接続の状態", { exact: true });
    await expect(label).toBeVisible();
    const badge = conn.locator('[data-slot="status-badge"]');
    expect(await styleOf(badge, ["height", "borderTopLeftRadius", "fontSize"])).toEqual({ height: "20px", borderTopLeftRadius: "3px", fontSize: "12px" });
    // 「接続の状態」・札・シェブロンの順
    const xs = await Promise.all([label.boundingBox(), badge.boundingBox(), conn.locator("svg").boundingBox()]);
    expect(xs[0]!.x).toBeLessThan(xs[1]!.x);
    expect(xs[1]!.x).toBeLessThan(xs[2]!.x);

    // 640px 未満は文字を視覚的に隠す（名前は残る）。札とシェブロンは残る
    await page.setViewportSize({ width: 500, height: 720 });
    expect((await label.boundingBox())!.width).toBeLessThanOrEqual(1);
    await expect(conn).toHaveAccessibleName(/^接続の状態/);
    await expect(badge).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });

    // 開くとシェブロンが上向き（180 度回る）
    await conn.click();
    await expect(conn).toHaveAttribute("aria-expanded", "true");
    // Tailwind CSS v4 の rotate-* は、CSS の rotate の属性（transform ではない）
    await expect.poll(() => conn.locator("svg").evaluate((el) => getComputedStyle(el).rotate)).toBe("180deg");
    await page.keyboard.press("Escape");
  });

  test("接続の状態の「接続確認」：押した結果だけを role=status に文で入れる", async ({ page }) => {
    await asAdmin(page);
    const conn = page.getByTestId("conn-button");
    await conn.click();
    const report = page.getByTestId("conn-report");
    await expect(report).toHaveText("");
    await page.getByTestId("conn-check").click();
    await expect(report).toHaveText(/^\d+ 件(すべてに接続できました。|のうち \d+ 件に接続できませんでした。)$/);
    await expect(page.getByTestId("conn-popover")).toBeVisible();
    // 札は読み上げない：ボタンにも popover の他の場所にも aria-live を持たせない
    expect(await page.getByTestId("conn-popover").locator("[aria-live]").count()).toBe(1);
    await expect(conn.locator("[aria-live]")).toHaveCount(0);
  });

  test("ボタン：表の上の操作は 28px・角 4px・影なし。副の地は白", async ({ page }) => {
    await asAdmin(page);
    await page.goto("/modalities");
    const all = page.getByTestId("echo-all");
    await expect(all).toBeVisible();
    // 表の上の操作は小さいボタン（.btn-sm 28px）。標準（32px）は受け取りの「読み直す」
    expect(await styleOf(all, ["height", "borderTopLeftRadius", "boxShadow", "borderTopWidth"])).toEqual({
      height: "28px",
      borderTopLeftRadius: "4px",
      boxShadow: "none",
      borderTopWidth: "1px",
    });
    await page.goto("/received");
    const reload = page.getByTestId("received-reload");
    // 標準（32px）は単体試験（tests/unit/ui-parts-render.test.ts）で見る。ここは副のボタンの地・角・影
    expect(await styleOf(reload, ["height", "borderTopLeftRadius", "boxShadow", "backgroundColor"])).toMatchObject({
      height: "28px",
      borderTopLeftRadius: "4px",
      boxShadow: "none",
      backgroundColor: "rgb(255, 255, 255)",
    });
  });

  // 空の状態の部品は、いまは権限の無い頁（denied。実線）だけが使う。点線（既定）の形は tests/unit/ui-parts-render.test.ts で見る
  test("空の状態（権限の無い頁）：中央寄せの枠（枠 1px 実線・角 6px・内 32px 16px）", async ({ page }) => {
    await asAdmin(page);
    await page.getByTestId("dev-mode-band").getByRole("button", { name: "一般" }).click();
    await page.goto("/admin/viewers");
    const empty = page.locator('[data-slot="empty-state"]');
    await expect(empty).toBeVisible();
    const s = await styleOf(empty, ["borderTopStyle", "borderTopWidth", "borderTopLeftRadius", "textAlign", "alignItems", "paddingTop", "paddingLeft"]);
    expect(s).toEqual({
      borderTopStyle: "solid",
      borderTopWidth: "1px",
      borderTopLeftRadius: "6px",
      textAlign: "center",
      alignItems: "center",
      paddingTop: "32px",
      paddingLeft: "16px",
    });
  });

  test("知らせ：枠 1px・左だけ 4px・角 4px", async ({ page }) => {
    await asAdmin(page);
    await page.goto("/modalities");
    await page.getByTestId("echo-all").click();
    const notice = page.getByTestId("echo-notice");
    await expect(notice).toBeVisible();
    const s = await styleOf(notice, ["borderTopWidth", "borderLeftWidth", "borderTopLeftRadius"]);
    expect(s).toEqual({ borderTopWidth: "1px", borderLeftWidth: "4px", borderTopLeftRadius: "4px" });
  });

  test("上の帯と左のナビの写し（1280 幅）を撮る", async ({ page }, info) => {
    await asAdmin(page);
    await page.waitForTimeout(500);
    const dir = process.env.KIT120_SHOTS;
    if (!dir) info.skip(true, "KIT120_SHOTS が無いので撮らない");
    await page.screenshot({ path: `${dir}/tsunagi-1280.png`, clip: { x: 0, y: 0, width: 1280, height: 420 } });
  });
});
