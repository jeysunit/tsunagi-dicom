import { randomInt } from "node:crypto";
import { appendAudit, appendAuditWith, type AuditEntryInput } from "@/lib/audit";
import { AUTH_MODE_LOCAL, type AuthContext } from "@/lib/auth/local-auth";
import { hashPassword } from "@/lib/auth/password-hash";
import { checkPassword } from "@/lib/auth/password-policy";

// 管理者のパスワードを失くしたときの戻し方（docs/spec.md の 3.6）。
// コンテナの中でだけ流せるコマンド（src/cli/reset-admin-password.ts）から呼ぶ。画面・API からは呼ばない。
// 新しい一時のパスワードを決めて返し、次のログインで本人が変える（mustChangePassword）。
// 認証の世代を上げてセッションを閉じる。TOTP は、resetTotp のときだけ消す（既定は残す）。
// 監査の記録には、誰が（コンテナの中の操作）・いつ・どの利用者をを残す。パスワードは記録に入れない。
//
// コンテナの中でコマンドを流せる人は、データベースのファイルと SESSION_SECRET にも触れる。
// つまり「台に入れる人は管理者になれる」ことは、このコマンドの有無で変わらない。このコマンドは、その人が
// 記録を残さずに行う道ではなく、記録を残して行う道を用意するためのもの。

/** 監査の記録の「誰が」。画面の利用者ではなく、コンテナの中のコマンド */
export const CONTAINER_CLI_ACTOR = { actorId: "container-cli", actorRole: "system" } as const;

export class AdminResetError extends Error {
  constructor(
    message: string,
    readonly reason: "not_found" | "not_admin" | "disabled",
  ) {
    super(message);
    this.name = "AdminResetError";
  }
}

/** コマンドを流した者の手がかり。OS の利用者名は確かめた値、operator は自分で名乗った値（確かめていない） */
export interface ResetOperator {
  osUser: string;
  hostname: string;
  operator?: string;
}

export interface ResetOptions {
  username: string;
  /** TOTP も消す（認証のアプリも失くしたとき）。既定は残す */
  resetTotp?: boolean;
  operator: ResetOperator;
  /** 試験で差し替える。既定は乱数 */
  generatePassword?: (username: string, mfaRequired: boolean) => string;
}

export interface ResetResult {
  username: string;
  /** 一時のパスワード。呼んだ側が1回だけ出す */
  password: string;
  totpReset: boolean;
  /** 戻す前に TOTP を登録していたか */
  hadTotp: boolean;
  sessionsClosed: number;
}

// 紛らわしい字（0・o・1・l・i）を除く。1 組 6 字を 4 組、ハイフンでつなぐ（24 字。約 119 ビット）
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const GROUPS = 4;
const GROUP_LENGTH = 6;

export function generateTemporaryPassword(username: string, mfaRequired: boolean): string {
  for (;;) {
    const groups = Array.from({ length: GROUPS }, () =>
      Array.from({ length: GROUP_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join(""),
    );
    const candidate = groups.join("-");
    // 規則（英字と数字の混在・利用者名を含まない）に合うまで引き直す
    if (checkPassword(candidate, { mfaRequired, username }).length === 0) return candidate;
  }
}

/**
 * 管理者（有効なもの）のパスワードを一時のものに替える。
 * 利用者がいない・管理者でない・止めてあるときは、AdminResetError で断り、断ったことも監査の記録に残す
 */
export async function resetAdminPassword(ctx: AuthContext, options: ResetOptions): Promise<ResetResult> {
  const { username, operator } = options;
  const at = ctx.now ? ctx.now() : new Date();
  const base = {
    ...CONTAINER_CLI_ACTOR,
    authMode: AUTH_MODE_LOCAL,
    occurredAt: at,
  } satisfies Partial<AuditEntryInput>;
  const who = { via: "container_cli", osUser: operator.osUser, hostname: operator.hostname, operator: operator.operator ?? null };

  // 断ったことも記録に残す
  const deny = async (reason: AdminResetError["reason"], message: string): Promise<never> => {
    await appendAudit(ctx.db, {
      ...base,
      action: "admin_password_reset",
      outcome: "denied",
      detail: { target: username, reason, ...who },
    });
    throw new AdminResetError(message, reason);
  };

  const target = await ctx.db.user.findUnique({ where: { username } });
  if (target === null) return deny("not_found", "その利用者はいません");
  if (target.role !== "admin") return deny("not_admin", "管理者ではない利用者には使えません");
  if (target.status !== "active") return deny("disabled", "止めてある管理者には使えません");

  const password = (options.generatePassword ?? generateTemporaryPassword)(username, ctx.settings.mfaRequired);
  const resetTotp = options.resetTotp === true;
  const passwordHash = await hashPassword(password);

  const { value: sessionsClosed } = await appendAuditWith(ctx.db, async (tx) => {
    await tx.user.update({
      where: { id: target.id },
      data: {
        passwordHash,
        passwordChangedAt: at,
        // 次のログインで本人が変える
        mustChangePassword: true,
        // 認証の世代を上げ、いまのセッションを使えなくする（削除は後片付け）
        credentialVersion: { increment: 1 },
        // 失くしたパスワードの試みで一時停止になっていても、戻せるようにする
        failedLoginCount: 0,
        lockedUntil: null,
        ...(resetTotp ? { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } : {}),
        updatedAt: at,
      },
    });
    const closed = await tx.session.deleteMany({ where: { userId: target.id } });
    return {
      value: closed.count,
      input: {
        ...base,
        action: "admin_password_reset",
        detail: { target: username, totpReset: resetTotp, sessionsClosed: closed.count, ...who },
      },
    };
  });

  return { username, password, totpReset: resetTotp, hadTotp: target.totpSecretEnc !== null, sessionsClosed };
}
