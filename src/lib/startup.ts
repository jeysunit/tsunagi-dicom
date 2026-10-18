import { ConfigError, loadConfig } from "@/lib/config";

/**
 * 設定に誤りがあれば、どの変数かを出して起動を止める。AUTH_MODE=local では最初の管理者も確かめ、
 * 期限の切れたセッションを片付け、一定の間隔の片付けを始める
 */
export async function checkConfigOrExit(): Promise<void> {
  let config;
  try {
    config = loadConfig();
    console.info(
      `tsunagi-dicom: BACKEND_KIND=${config.backend.kind} BACKEND_MOCK=${config.backend.mock} AUTH_MODE=${config.auth.mode}`,
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  if (config.auth.mode !== "local") return;
  const [{ bootstrapInitialAdmin, BootstrapError }, { createDb, getDb }, { purgeExpiredSessions, flushFailureDigest }] =
    await Promise.all([import("@/lib/auth/bootstrap"), import("@/lib/db"), import("@/lib/auth/local-auth")]);
  const settings = {
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
  };
  const source = { sourceAddress: null, sourceAddressUnverified: null };
  const db = await createDb(config.databaseUrl);
  try {
    const result = await bootstrapInitialAdmin({ db, settings, source }, config);
    await purgeExpiredSessions(db);
    if (result === "created") {
      console.info(`tsunagi-dicom: 最初の管理者（${config.auth.initialAdmin?.username}）を作った。最初のログインでパスワードを変える`);
    } else if (result === "skipped" && config.auth.initialAdmin) {
      console.info("tsunagi-dicom: 利用者がもういるので、INITIAL_ADMIN_* は使わなかった（外してよい）");
    } else if (result === "no-users") {
      console.error(
        "設定に誤りがあるため起動しない（.env.example と docs/spec.md の 2.1 を見る）:\n" +
          "  - INITIAL_ADMIN_USERNAME: AUTH_MODE=local で利用者が1人もいない。INITIAL_ADMIN_USERNAME と INITIAL_ADMIN_PASSWORD_FILE で最初の管理者を作る",
      );
      process.exit(1);
    }
  } catch (error) {
    if (error instanceof BootstrapError) {
      console.error(`設定に誤りがあるため起動しない:\n  - ${error.message}`);
      process.exit(1);
    }
    throw error;
  } finally {
    await db.$disconnect();
  }

  // 一定の間隔の片付け：期限の切れたセッションを消し、まとめておいたログインの失敗を記録に書く。
  // プロセスの終わりを待たせない（unref）。失敗しても次の間隔でやり直す
  const timer = setInterval(() => {
    void (async () => {
      const shared = await getDb();
      await purgeExpiredSessions(shared);
      await flushFailureDigest({ db: shared, settings, source });
    })().catch((error: unknown) => console.error("tsunagi-dicom: 定期の片付けに失敗した", error));
  }, HOUSEKEEPING_INTERVAL_MS);
  timer.unref();
}

/** 定期の片付けの間隔 */
export const HOUSEKEEPING_INTERVAL_MS = 60_000;
