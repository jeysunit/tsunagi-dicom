import { randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// 画面の試験。モックのバックエンド（tests/fixtures の合成のデータ）に対して流す。
// 先に `npm run build` で standalone を作っておく（scripts/e2e-server.mjs が起動する）。

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;
/** AUTH_MODE=local の試験のサーバー */
const LOCAL_PORT = 3102;
export const LOCAL_BASE_URL = `http://127.0.0.1:${LOCAL_PORT}`;

/** 画像サーバーのパスワードの代わりの印。画面と API の応答に出ないことを確かめる */
export const BACKEND_PASSWORD_MARKER = "e2e-backend-password-must-not-leak";

export const e2eEnv = {
  BACKEND_KIND: "orthanc",
  BACKEND_MOCK: "true",
  BACKEND_USERNAME: "e2e-user",
  BACKEND_PASSWORD: BACKEND_PASSWORD_MARKER,
  AUTH_MODE: "dev",
  DEV_ALLOW_WRITE: "false",
  SESSION_SECRET: randomBytes(48).toString("base64"),
  DATABASE_URL: `file:${path.resolve(".e2e/e2e.db")}`,
  TZ: "Asia/Tokyo",
  // ビューアの選び分けの試験（段 2）。例の名前だけ。画面の試験は BFF の移り先を控えるだけで、この宛先へは通信しない
  VIEWER_OHIF_URL: "https://viewer.example.org/ohif",
  VIEWER_STONE_URL: "https://viewer.example.org/stone",
  PUBLIC_DICOMWEB_URL: "https://pacs.example.org/dicom-web",
  // Next.js の待ち受けの住所（AUTH_MODE=dev の起動の条件ではない。dev はモックのときだけ起動する）
  HOSTNAME: "127.0.0.1",
  PORT: String(PORT),
  // 試験のデータベースを作る prisma migrate deploy が、外へ版の確かめを送らないようにする
  CHECKPOINT_DISABLE: "1",
};

/** AUTH_MODE=local の試験の、最初の管理者（試験だけの値） */
export const E2E_ADMIN = { username: "e2e-admin", password: "e2e-Initial-7xq4" };

export const localEnv = {
  ...e2eEnv,
  AUTH_MODE: "local",
  DEV_ALLOW_WRITE: "",
  MFA_REQUIRED: "true",
  LOGIN_LOCK_THRESHOLD: "3",
  LOGIN_LOCK_MINUTES: "1",
  SCREEN_LOCK_MINUTES: "1",
  // 試験の要求はどれも同じ接続元（ヘッダー無し）として数えるので、回数の上限を広げる（上限そのものは単体の試験で見る）
  LOGIN_RATE_LIMIT_PER_MINUTE: "200",
  INITIAL_ADMIN_USERNAME: E2E_ADMIN.username,
  INITIAL_ADMIN_PASSWORD_FILE: path.resolve(".e2e/local/initial-admin-password.txt"),
  E2E_INITIAL_ADMIN_PASSWORD: E2E_ADMIN.password,
  DATABASE_URL: `file:${path.resolve(".e2e/local/e2e.db")}`,
  PORT: String(LOCAL_PORT),
  // standalone の .next/static は、検証モードのサーバーの方で写す（同時に写さない）
  E2E_SKIP_PREPARE: "true",
  // 検査一覧の自動更新を止める形は、こちらのサーバーで確かめる（検証モードのサーバーは既定の 30 秒）
  STUDY_LIST_REFRESH_SECONDS: "0",
};

export default defineConfig({
  testDir: "tests/e2e",
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    locale: "ja-JP",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 },
        // 入っている Chromium を使うとき（クラウドの開発環境など）だけ指定する
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
      },
    },
  ],
  webServer: [
    {
      command: "node scripts/e2e-server.mjs",
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: e2eEnv,
    },
    {
      command: "node scripts/e2e-server.mjs",
      url: `${LOCAL_BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: localEnv,
    },
  ],
});
