import { randomBytes } from "node:crypto";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// 画面の試験。モックのバックエンド（tests/fixtures の合成のデータ）に対して流す。
// 先に `npm run build` で standalone を作っておく（scripts/e2e-server.mjs が起動する）。

const PORT = 3100;
const baseURL = `http://127.0.0.1:${PORT}`;

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
  // Next.js の待ち受けの住所（AUTH_MODE=dev の起動の条件ではない。dev はモックのときだけ起動する）
  HOSTNAME: "127.0.0.1",
  PORT: String(PORT),
  // 試験のデータベースを作る prisma migrate deploy が、外へ版の確かめを送らないようにする
  CHECKPOINT_DISABLE: "1",
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
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: e2eEnv,
  },
});
