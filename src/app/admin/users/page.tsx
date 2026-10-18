import { redirect } from "next/navigation";
import { UserAdmin } from "@/components/admin/user-admin";
import { listUsers } from "@/lib/auth/local-auth";
import { pageAccess } from "@/lib/auth/page-session";
import { minPasswordLength } from "@/lib/auth/password-policy";
import { authContext } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

// 利用者の棚卸し（第7.0版 14 遵守事項⑧）と役割の設定（14.2）。管理者だけ。
// 最後のログインを出し、使われていない利用者を見つけやすくする。要らない利用者は止める（消さない）。
export default async function UsersPage() {
  const config = getConfig();
  if (config.auth.mode !== "local") redirect("/");
  const access = await pageAccess("user.manage");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden" || !access.session.local) {
    return (
      <p role="alert" className="text-label">
        管理者だけが開ける
      </p>
    );
  }
  const users = await listUsers(await authContext());
  const fmt = new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short", timeZone: config.timeZone });
  return (
    <UserAdmin
      csrfToken={access.session.local.row.csrfToken}
      selfId={access.session.local.user.id}
      minPasswordLength={minPasswordLength(config.auth.mfaRequired)}
      needsTotp={access.session.local.user.totpSecretEnc !== null}
      users={users.map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        status: u.status,
        totpEnabled: u.totpEnabled,
        lastLogin: u.lastLoginAt ? fmt.format(u.lastLoginAt) : null,
        lastLoginDaysAgo: u.lastLoginDaysAgo,
        created: fmt.format(u.createdAt),
        lockedUntil: u.lockedUntil ? fmt.format(u.lockedUntil) : null,
      }))}
    />
  );
}
