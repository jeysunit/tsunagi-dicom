import { redirect } from "next/navigation";
import { TotpEnrollment } from "@/components/auth/totp-enrollment";
import { startEnrollment } from "@/lib/auth/local-auth";
import { pageAccess } from "@/lib/auth/page-session";
import { authContext } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

// 二要素が任意（MFA_REQUIRED=false）のときの、ログインした後の TOTP の登録。登録すると、次からログインで要る。
export const metadata = { title: "二要素認証の設定" };

export default async function AccountTotpPage() {
  const config = getConfig();
  if (config.auth.mode !== "local" || config.auth.mfaRequired) redirect("/account");
  const access = await pageAccess();
  if (access.kind !== "ok" || !access.session.local) return null;
  const { row, user } = access.session.local;
  if (user.totpSecretEnc) redirect("/account");
  const enrollment = await startEnrollment(await authContext(), row, user);
  return (
    <section className="max-w-md space-y-4">
      <h1 className="text-lg font-bold text-value">二要素の認証（TOTP）の登録</h1>
      <TotpEnrollment secret={enrollment.secret} uri={enrollment.uri} csrfToken={row.csrfToken} askPassword />
    </section>
  );
}
