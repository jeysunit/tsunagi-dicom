import { hostname, userInfo } from "node:os";
import { parseArgs } from "node:util";
import { AdminResetError, resetAdminPassword } from "@/lib/auth/admin-reset";
import type { AuthContext } from "@/lib/auth/local-auth";
import { isValidUsername, USERNAME_HINT } from "@/lib/auth/username";

// 管理者のパスワードを失くしたときに戻すコマンド（docs/spec.md の 3.6）。コンテナの中でだけ流す：
//   docker compose exec tsunagi node cli/reset-admin-password.mjs --user <ユーザーID>
// 画面・API からは使えない。新しい一時のパスワードを標準出力に1回だけ出し（ほかの文は標準エラー出力）、
// 次のログインで変更を求める。使ったことは監査の記録に残る。

export const USAGE = [
  "使い方: node cli/reset-admin-password.mjs --user <ユーザーID> [--reset-totp] [--operator <記録に残す名前>]",
  "",
  "  --user         パスワードを戻す管理者のユーザーID（有効な管理者だけ）",
  "  --reset-totp   TOTP も消す（認証のアプリも失くしたとき）。付けなければ TOTP は残す",
  "  --operator     監査の記録に残す、コマンドを流した人の名前（自己申告。確かめない）",
  "",
  "新しい一時のパスワードを標準出力に1回だけ出します。次のログインで本人が変えます。",
].join("\n");

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

export interface CliContext {
  ctx: AuthContext;
  close(): Promise<void>;
}

export interface CliDeps {
  /** 設定とデータベースを開く。AUTH_MODE=local でなければ投げる */
  open(): Promise<CliContext>;
  operator?: { osUser: string; hostname: string };
}

/** 終了コード：0 戻した／1 断った・失敗／2 使い方の誤り・設定の誤り */
export async function run(argv: string[], io: CliIo, deps: CliDeps): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        user: { type: "string" },
        "reset-totp": { type: "boolean", default: false },
        operator: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }
  const username = values.user;
  if (username === undefined || !isValidUsername(username)) {
    io.err(`--user には、ユーザーIDを指定してください（${USERNAME_HINT}）\n${USAGE}\n`);
    return 2;
  }
  const operatorLabel = values.operator?.trim();
  if (operatorLabel !== undefined && (operatorLabel === "" || operatorLabel.length > 100)) {
    io.err("--operator は 1〜100 文字で指定してください\n");
    return 2;
  }

  let opened: CliContext;
  try {
    opened = await deps.open();
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  try {
    const operator = deps.operator ?? { osUser: userInfo().username, hostname: hostname() };
    const result = await resetAdminPassword(opened.ctx, {
      username,
      resetTotp: values["reset-totp"],
      operator: { ...operator, ...(operatorLabel ? { operator: operatorLabel } : {}) },
    });
    // パスワードは標準出力に1回だけ。ほかの文は標準エラー出力（$(…) で受けても混ざらない）
    io.out(`${result.password}\n`);
    io.err(
      [
        `${result.username} のパスワードを一時のものに替えました。上の1行が新しいパスワードです。もう表示しません。`,
        "次のログインで、本人がパスワードを変えます。",
        result.totpReset
          ? "TOTP を消しました。MFA_REQUIRED=true なら、次のログインで登録し直します。"
          : result.hadTotp
            ? "TOTP は残してあります。ログインには認証のアプリの番号が要ります。"
            : "この管理者は TOTP を登録していません。",
        `ログイン中のセッション ${result.sessionsClosed} 件を閉じました。監査の記録に残しました。`,
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    if (error instanceof AdminResetError) {
      io.err(`${error.message}（監査の記録に、断ったことを残しました）\n`);
      return 1;
    }
    io.err(`失敗しました：${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await opened.close();
  }
}
