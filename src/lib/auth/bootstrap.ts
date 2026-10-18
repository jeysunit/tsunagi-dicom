import { readFileSync } from "node:fs";
import { AuthFailure, createUser, type AuthContext } from "@/lib/auth/local-auth";
import type { AppConfig } from "@/lib/config";

// 最初の管理者を作る（AUTH_MODE=local。docs/spec.md の 2.1・3.6）。
// 利用者が1人もいないときだけ、INITIAL_ADMIN_USERNAME と INITIAL_ADMIN_PASSWORD_FILE（秘密のファイル）から作る。
// 利用者が1人でもいれば何もしない（1回だけ。後から設定を残したままでも、パスワードを書き換えない）。
// 作った管理者は、最初のログインでパスワードを変え（mustChangePassword）、MFA_REQUIRED=true なら TOTP を登録する。

export type BootstrapResult = "created" | "skipped" | "no-users";

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface BootstrapOptions {
  readFile?: (path: string) => string;
}

export async function bootstrapInitialAdmin(
  ctx: AuthContext,
  config: Pick<AppConfig, "auth">,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const users = await ctx.db.user.count();
  const initial = config.auth.initialAdmin;
  if (users > 0) return "skipped";
  if (!initial) return "no-users";

  let password: string;
  try {
    password = readFile(initial.passwordFile).replace(/\r?\n$/, "");
  } catch {
    throw new BootstrapError("INITIAL_ADMIN_PASSWORD_FILE: ファイルを読めない");
  }
  try {
    await createUser(
      ctx,
      { username: initial.username, displayName: "管理者", role: "admin", password, mustChangePassword: true },
      { actorId: "system", actorRole: "none" },
    );
  } catch (error) {
    if (error instanceof AuthFailure) {
      // パスワードそのものは文言に入れない
      throw new BootstrapError(`最初の管理者を作れない：${[error.message, ...error.problems].join("・")}`);
    }
    throw error;
  }
  return "created";
}
