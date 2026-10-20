import path from "node:path";
import { defineConfig } from "@playwright/test";

// 開発用の compose（docker/dev/compose.yaml）の流れの試験。node tests/flow/run.mjs から流す
// （docker/dev/up.sh で一式を立て、終わったら片付ける）。tsunagi-dicom はコンテナの中で動くので、webServer は使わない。

const root = process.cwd();

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: path.join(root, "test-results/flow"),
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 300_000,
  // 入力した値（試験の管理者のパスワード）が残りうるので、HTML の報告と trace は作らない（tests/integration と同じ）
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${process.env.TSUNAGI_HTTP_PORT ?? "3000"}`,
    locale: "ja-JP",
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
});
