import { redirect } from "next/navigation";
import { PasswordForm } from "@/components/auth/auth-forms";
import { minPasswordLength } from "@/lib/auth/password-policy";
import { getAuthState } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";
import { getConfig } from "@/lib/config";

// 管理者が決めたパスワード（最初のログイン）や、いまの規則に合わないパスワードを、本人が変える。
export const metadata = { title: "パスワードの変更" };

export default async function ChangePasswordStagePage() {
  const state = await getAuthState();
  if (state.kind !== "pending") redirect(state.kind === "anonymous" ? "/login" : "/");
  if (state.stage !== "change_password") redirect(STAGE_PATHS[state.stage]);
  return (
    <section className="mx-auto w-full max-w-[var(--w-login)] space-y-4 pt-8">
      <h1 className="text-lg font-bold text-value">パスワードの変更</h1>
      <p className="text-label">ログインを続けるには、パスワードを変更してください</p>
      <PasswordForm
        csrfToken={state.row.csrfToken}
        askCurrent={false}
        minLength={minPasswordLength(getConfig().auth.mfaRequired)}
      />
    </section>
  );
}
