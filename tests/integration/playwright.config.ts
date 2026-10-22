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
  // HTML の報告は、操作の手順の名前に入力した値が入りうるので作らない（CI の記録の list だけ）
  reporter: "list",
  use: {
    baseURL: bffUrl,
    locale: "ja-JP",
    // trace は入力した値（試験だけの管理者のパスワード）と通信の中身を残し、CI の成果物として上がるので、取らない。
    // 失敗の手がかりは、画面の写し（スクリーンショット。パスワードの欄は伏せ字で写る）と error-context.md・コンテナの記録
    trace: "off",
    screenshot: "only-on-failure",
    video: "off",
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
      // 監査の記録の先頭の控え（試験の 9 で、/api/audit/verify が照らし合わせることを見る）
      AUDIT_ANCHOR_FILE: path.join(ITEST.workDir, "audit-anchors.jsonl"),
      TZ: "Asia/Tokyo",
      // 画像ごとの「主なタグ」（試験の 14）：3 つの書き方を混ぜ、患者の値・画像に無いタグ・ファイルのメタ情報も入れる
      INSTANCE_TAGS: "(0020,0013) 0008,0018 00100010 (0008,1030) (0028,0010) (0018,0050) (0002,0010)",
      HOSTNAME: "127.0.0.1",
      PORT: String(ITEST.bffPort),
      CHECKPOINT_DISABLE: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
