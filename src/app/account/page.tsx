import Link from "next/link";
import { redirect } from "next/navigation";
import { PasswordForm } from "@/components/auth/auth-forms";
import { pageAccess } from "@/lib/auth/page-session";
import { minPasswordLength } from "@/lib/auth/password-policy";
import { getConfig } from "@/lib/config";

// 自分の設定：パスワードの変更と、二要素が任意（MFA_REQUIRED=false）のときの TOTP の登録。
export default async function AccountPage() {
  const config = getConfig();
  if (config.auth.mode !== "local") redirect("/");
  const access = await pageAccess();
  if (access.kind !== "ok" || !access.session.local) return null;
  const { row, user } = access.session.local;
  return (
    <section className="max-w-sm space-y-6">
      <h1 className="text-lg font-bold text-value">自分の設定</h1>
      <div className="space-y-2">
        <h2 className="font-bold text-value">パスワードの変更</h2>
        <PasswordForm
          csrfToken={row.csrfToken}
          askCurrent
          askCode={user.totpSecretEnc !== null}
          minLength={minPasswordLength(config.auth.mfaRequired)}
        />
      </div>
      <div className="space-y-2">
        <h2 className="font-bold text-value">二要素の認証（TOTP）</h2>
        {user.totpSecretEnc ? (
          <p className="text-label">登録している。やり直すときは管理者に頼む。</p>
        ) : config.auth.mfaRequired ? (
          <p className="text-label">次のログインで登録する。</p>
        ) : (
          <Link href="/account/totp" prefetch={false} className="text-primary underline">
            TOTP を登録する
          </Link>
        )}
      </div>
    </section>
  );
}
