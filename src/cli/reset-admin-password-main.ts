import { run, type CliContext } from "@/cli/reset-admin-password";
import { getConfig } from "@/lib/config";
import { createDb } from "@/lib/db";

// コンテナの中で流す入口（npm run build:cli が dist/cli/reset-admin-password.mjs にまとめる）。
// 設定はサーバーと同じ環境変数から読む（SESSION_SECRET は監査の記録の鍵を導くのに使う）。
// 設定の誤り（ConfigError）は、どの変数かを含む文のまま run が標準エラー出力に出す。

async function open(): Promise<CliContext> {
  const config = getConfig();
  if (config.auth.mode !== "local") {
    throw new Error("AUTH_MODE=local のときだけ使えます（利用者のパスワードを持つのは local のときだけです）");
  }
  const db = await createDb(config.databaseUrl);
  return {
    close: () => db.$disconnect(),
    ctx: {
      db,
      source: { sourceAddress: null, sourceAddressUnverified: null },
      settings: {
        mfaRequired: config.auth.mfaRequired,
        loginLockThreshold: config.auth.loginLockThreshold,
        loginLockMinutes: config.auth.loginLockMinutes,
        screenLockMinutes: config.auth.screenLockMinutes,
        screenUnlockRequireTotp: config.auth.screenUnlockRequireTotp,
        sessionSecret: config.sessionSecret,
        rateLimitPerUserPerMinute: config.auth.rateLimitPerUserPerMinute,
        rateLimitGlobalPerMinute: config.auth.rateLimitGlobalPerMinute,
        passwordHashConcurrency: config.auth.passwordHashConcurrency,
        passwordHashQueue: config.auth.passwordHashQueue,
        pendingSessionMinutes: config.auth.pendingSessionMinutes,
        sessionMaxHours: config.auth.sessionMaxHours,
        reauthMinutes: config.auth.reauthMinutes,
      },
    },
  };
}

// 標準出力を出し切ってから終わる（process.exit で切らない）
process.exitCode = await run(
  process.argv.slice(2),
  { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) },
  { open },
);
