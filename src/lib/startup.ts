import { ConfigError, loadConfig } from "@/lib/config";

/** 設定に誤りがあれば、どの変数かを出して起動を止める。AUTH_MODE=local では最初の管理者も確かめる */
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
  const [{ bootstrapInitialAdmin, BootstrapError }, { createDb }] = await Promise.all([
    import("@/lib/auth/bootstrap"),
    import("@/lib/db"),
  ]);
  const db = await createDb(config.databaseUrl);
  try {
    const result = await bootstrapInitialAdmin(
      {
        db,
        settings: {
          mfaRequired: config.auth.mfaRequired,
          loginLockThreshold: config.auth.loginLockThreshold,
          loginLockMinutes: config.auth.loginLockMinutes,
          screenLockMinutes: config.auth.screenLockMinutes,
          sessionSecret: config.sessionSecret,
        },
        source: { sourceAddress: null, sourceAddressUnverified: null },
      },
      config,
    );
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
}
