import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/auth-forms";
import { getAuthState } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

// ログイン（AUTH_MODE=local）。検証モード（dev）にはログインが無い。
export const metadata = { title: "ログイン" };

export default async function LoginPage() {
  if (getConfig().auth.mode !== "local") redirect("/");
  const state = await getAuthState();
  if (state.kind === "active" || state.kind === "locked") redirect("/");
  return (
    <section className="mx-auto max-w-sm space-y-4 pt-8">
      <h1 className="text-lg font-bold text-value">ログイン</h1>
      <LoginForm />
    </section>
  );
}
