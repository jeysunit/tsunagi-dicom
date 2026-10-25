import { expect, test, type Page } from "@playwright/test";

// 送信一覧（docs/spec.md の 3.4。送受信の一覧の送る側の形）。検証モード（AUTH_MODE=dev）とモックの Orthanc に対して流す。
// この試験のサーバーは DEV_ALLOW_WRITE=false なので送信の記録が無い。空の画面は本物の画面の API で、行のある画面は
// 画面の API の答えを試験の中の合成の行（架空の患者）に差し替えて確かめる（BFF の組み立ては tests/unit/sent-log.test.ts）。

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const STATUSES = ["sent", "failed", "unknown", "running", "pending"] as const;

async function asRole(page: Page, label: "管理者" | "一般") {
  await page.goto("/");
  const button = page.getByTestId("dev-mode-band").getByRole("button", { name: label });
  if ((await button.getAttribute("aria-pressed")) !== "true") {
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
  }
}

/** 合成の送信の行（新しい順）。n 件、状態は 5 つを順に回す */
function fakeRows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    requestId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    requestedAt: new Date(Date.UTC(2026, 9, 25, 23, 59) - i * 60_000).toISOString(),
    finishedAt: STATUSES[i % 5] === "sent" || STATUSES[i % 5] === "failed" ? new Date(Date.UTC(2026, 9, 26, 0, 0) - i * 60_000).toISOString() : null,
    destination: i % 2 === 0 ? "dtg" : "workstation",
    destinationAet: i % 2 === 0 ? "DTG_SCP" : "WS_SCP",
    status: STATUSES[i % 5],
    study: {
      studyInstanceUid: `${STUDY}.${i}`,
      patientId: `JP-TEST-${String(i).padStart(4, "0")}`,
      patientName: `試験 ${i}郎`,
      patientKana: `シケン ${i}ロウ`,
      modalities: ["CT"],
      studyDescription: "胸部 単純",
      studyDate: "20261025",
      studyTime: "101500",
      accessionNumber: `A26102500${String(i).padStart(2, "0")}`,
      instanceCount: 100 + i,
    },
  }));
}

async function withRows(page: Page, n: number, truncated = false) {
  await page.route((url) => url.pathname === "/api/sent-log", (route) =>
    route.fulfill({ json: { items: fakeRows(n), truncated, limit: 1000, from: "2026-10-26", to: "2026-10-26" } }),
  );
}

test("送信一覧：一般は左のナビの業務の群（受信一覧の下）から開け、送信の記録が無いときは事実と次の手を出す", async ({ page }) => {
  await asRole(page, "一般");
  const nav = page.getByRole("navigation", { name: "ページ" });
  const links = nav.getByRole("link");
  const labels = await links.allTextContents();
  expect(labels.indexOf("送信一覧")).toBe(labels.indexOf("受信一覧") + 1);
  await nav.getByRole("link", { name: "送信一覧" }).click();
  await expect(page).toHaveURL(/\/sent$/);
  await expect(page).toHaveTitle("送信一覧 - tsunagi-dicom");
  await expect(page.locator("main h1")).toHaveText("送信一覧");
  await expect(page.getByTestId("sent-count")).toHaveText("0");
  await expect(page.getByTestId("sent-empty")).toContainText("この期間の送信ジョブはありません。");
  await expect(page.getByTestId("sent-empty")).toContainText("期間を変えて、もう一度検索してください。");
  // 表の見出しの行は、空でも残す（列は 9 つ）
  await expect(page.getByTestId("sent-table").locator("thead th")).toHaveCount(9);
  await expect(page.getByTestId("sent-table").locator("thead th")).toHaveText([
    "受付日時",
    "送信先",
    "患者ID",
    "氏名",
    "モダリティと検査名",
    "画像数",
    "状態",
    "保管の確認",
    "操作",
  ]);
  // 画面の API は一般にも許す（読むだけ）。形の合わない期間は断る
  expect((await page.request.get("/api/sent-log?period=week")).status()).toBe(200);
  expect((await page.request.get("/api/sent-log?period=range&from=2026-10-03&to=2026-10-01")).status()).toBe(400);
  // 書き込みの操作は置かない（再送信は検査の詳細の「送信」から）
  await expect(page.getByRole("button", { name: /再送信|送信する/ })).toHaveCount(0);
});

test("送信一覧：状態の要約・上限の知らせ・件数・ページ送り・選んだ行の下の詳細", async ({ page }) => {
  await asRole(page, "管理者");
  await withRows(page, 120, true);
  await page.goto("/sent");
  // 並び：状態の要約 → 検索の帯 → 上限の知らせ → 件数の行 → 表 → ページ送り
  const order = await page.getByTestId("sent-list").evaluate((el) =>
    [...el.querySelectorAll("[data-testid]")].map((n) => n.getAttribute("data-testid")).filter((t) =>
      ["sent-summary", "sent-searchband", "sent-limit", "sent-count", "sent-table", "sent-pager"].includes(t ?? ""),
    ),
  );
  expect(order).toEqual(["sent-summary", "sent-searchband", "sent-limit", "sent-count", "sent-table", "sent-pager"]);
  await expect(page.getByTestId("sent-limit")).toHaveText("！送信ジョブが 1,000 件を超えたため、新しい 1,000 件だけを出しています。期間を狭めてください。");
  await expect(page.getByTestId("sent-count")).toHaveText("120");
  await expect(page.getByTestId("sent-sum-all")).toContainText("120");
  await expect(page.getByTestId("sent-sum-failed")).toContainText("送信失敗24");
  // 1 ページ 50 件（20・50・100）
  await expect(page.getByTestId("sent-row")).toHaveCount(50);
  await expect(page.getByTestId("sent-range")).toHaveText("1〜50 件目／全 120 件");
  await page.getByTestId("sent-next").click();
  await expect(page.getByTestId("sent-range")).toHaveText("51〜100 件目／全 120 件");
  await page.getByTestId("sent-page-size").selectOption("100");
  await expect(page.getByTestId("sent-row")).toHaveCount(100);
  await expect(page.getByTestId("sent-range")).toHaveText("1〜100 件目／全 120 件");

  // 1 行目：受付日時は TZ（Asia/Tokyo）の時刻、状態は札（文字と印）
  const first = page.getByTestId("sent-row").first();
  await expect(first.getByTestId("sent-at")).toHaveText("2026/10/26 08:59");
  await expect(first.getByTestId("sent-status")).toHaveText("✓送信完了");
  await expect(first.getByTestId("sent-commit")).toHaveText("—");

  // 状態の要約で絞る（もう一度「すべて」で戻す）
  await page.getByTestId("sent-sum-unknown").click();
  await expect(page.getByTestId("sent-sum-unknown")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("sent-count")).toHaveText("24");
  await page.getByTestId("sent-row").first().click();
  const detail = page.getByTestId("sent-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("sent-uid")).toContainText(`${STUDY}.2`);
  await expect(detail.getByTestId("sent-note")).toContainText("届いたか分かりません。dtg に");
  await expect(page.getByTestId("sent-row").first()).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("sent-sum-all").click();

  // 検索の帯：送信先と患者ID・氏名は「検索」で絞る
  await page.getByTestId("sent-destination").selectOption("workstation");
  await page.getByTestId("sent-text").fill("JP-TEST-0001");
  await page.getByTestId("sent-search").click();
  await expect(page.getByTestId("sent-count")).toHaveText("1");
  await expect(page.getByTestId("sent-row")).toHaveCount(1);
  await expect(page.getByTestId("sent-row").first()).toContainText("試験 1郎");
  await page.getByTestId("sent-clear").click();
  await expect(page.getByTestId("sent-count")).toHaveText("120");
  // 行の「検査一覧で表示」は、その検査を選んだ形の検査一覧へ
  await expect(page.getByTestId("sent-row").first().getByTestId("sent-open")).toHaveAttribute("href", `/?q=JP-TEST-0000&studyUid=${STUDY}.0`);
});

test("送信一覧：キーボードだけで 帯 → 表の行 → 操作 へ進み、Enter・Space で選び、矢印で隣の行へ、Esc で詳細を閉じる", async ({ page }) => {
  await asRole(page, "一般");
  await withRows(page, 3);
  await page.goto("/sent");
  await expect(page.getByTestId("sent-row")).toHaveCount(3);
  await page.getByTestId("sent-clear").focus();
  await page.keyboard.press("Tab");
  const rows = page.getByTestId("sent-row");
  await expect(rows.nth(0)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sent-detail")).toBeVisible();
  await expect(rows.nth(0)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(rows.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("sent-detail")).toHaveCount(0);
  await page.keyboard.press(" ");
  await expect(page.getByTestId("sent-detail")).toBeVisible();
  // 行の次は、その行の操作（検査一覧で表示）
  await page.keyboard.press("Tab");
  await expect(rows.nth(1).getByTestId("sent-open")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/q=JP-TEST-0001/);
});
