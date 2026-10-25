import { redirect } from "next/navigation";
import { CodeForm } from "@/components/auth/auth-forms";
import { getAuthState } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

// ログインの二要素：認証のアプリの確認の番号（TOTP）を入れる。
export const metadata = { title: "認証コードの入力" };

export default async function TotpPage() {
  const state = await getAuthState();
  if (state.kind !== "pending") redirect(state.kind === "anonymous" ? "/login" : "/");
  if (state.stage !== "totp") redirect(STAGE_PATHS[state.stage]);
  return (
    <section className="mx-auto w-full max-w-[var(--w-login)] space-y-4 pt-8">
      <h1 className="text-lg font-bold text-value">認証コードの入力</h1>
      <p className="text-label">認証アプリに表示された 6 桁のコードを入力してください</p>
      <CodeForm endpoint="/api/auth/totp" csrfToken={state.row.csrfToken} label="認証" />
    </section>
  );
}
