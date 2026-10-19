import path from "node:path";
import { defineConfig } from "@playwright/test";
import { bffUrl, gateUrl, ITEST, orthancUrl } from "./support/env";

// 結合の試験：本物の Orthanc と DCMTK（docker/test/compose.yaml のコンテナ）を相手に、BFF を
// BACKEND_MOCK=false・AUTH_MODE=local で動かす。node tests/integration/run.mjs から流す
// （コンテナを立て、試験だけの資格情報を作り、終わったら片付ける）。先に npm run build を流しておく。

// リポジトリの直下から流す（run.mjs がそうする。support/env.ts の場所もここから決める）
const root = process.cwd();

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: path.join(root, "test-results/integration"),
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 120_000,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never", outputFolder: path.join(root, "playwright-report/integration") }]]
    : "list",
  use: {
    baseURL: bffUrl,
    locale: "ja-JP",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 },
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
      },
    },
  ],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    cwd: root,
    url: `${bffUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      BACKEND_KIND: "orthanc",
      BACKEND_MOCK: "false",
      // REST は入口（試験の中の gate）を通す。DICOMweb は Orthanc へ直に
      BACKEND_ORTHANC_URL: gateUrl,
      BACKEND_DICOMWEB_URL: `${orthancUrl}/dicom-web`,
      BACKEND_USERNAME: process.env.ITEST_ORTHANC_USERNAME ?? "",
      BACKEND_PASSWORD_FILE: path.join(ITEST.workDir, "backend-password.txt"),
      AUTH_MODE: "local",
      // 管理者は TOTP を登録しない（再認証はパスワードだけ）。ログインの細かい振る舞いはモックの試験（tests/e2e）で見る
      MFA_REQUIRED: "false",
      SCREEN_LOCK_MINUTES: "0",
      LOGIN_RATE_LIMIT_PER_MINUTE: "200",
      INITIAL_ADMIN_USERNAME: "itest-admin",
      INITIAL_ADMIN_PASSWORD_FILE: path.join(ITEST.workDir, "initial-admin-password.txt"),
      E2E_INITIAL_ADMIN_PASSWORD: process.env.ITEST_ADMIN_INITIAL_PASSWORD ?? "",
      SESSION_SECRET: process.env.ITEST_SESSION_SECRET ?? "",
      DATABASE_URL: `file:${path.join(ITEST.workDir, "itest.db")}`,
      TZ: "Asia/Tokyo",
      HOSTNAME: "127.0.0.1",
      PORT: String(ITEST.bffPort),
      CHECKPOINT_DISABLE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
