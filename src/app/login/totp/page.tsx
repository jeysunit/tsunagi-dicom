import { redirect } from "next/navigation";
import { CodeForm } from "@/components/auth/auth-forms";
import { getAuthState } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

// ログインの二要素：認証のアプリの確認の番号（TOTP）を入れる。
export default async function TotpPage() {
  const state = await getAuthState();
  if (state.kind !== "pending") redirect(state.kind === "anonymous" ? "/login" : "/");
  if (state.stage !== "totp") redirect(STAGE_PATHS[state.stage]);
  return (
    <section className="mx-auto max-w-sm space-y-4 pt-8">
      <h1 className="text-lg font-bold text-value">確認の番号</h1>
      <p className="text-label">認証のアプリに出ている 6 桁の番号を入れる。</p>
      <CodeForm endpoint="/api/auth/totp" csrfToken={state.row.csrfToken} label="確かめる" />
    </section>
  );
}
