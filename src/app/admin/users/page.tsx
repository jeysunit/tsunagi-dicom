import { redirect } from "next/navigation";
import { UserAdmin } from "@/components/admin/user-admin";
import { listUsers } from "@/lib/auth/local-auth";
import { pageAccess } from "@/lib/auth/page-session";
import { minPasswordLength } from "@/lib/auth/password-policy";
import { authContext } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { formatDateTimeIn } from "@/lib/format/japanese-date";
import { ADMIN_ONLY } from "@/lib/ui-text";

// 利用者の棚卸し（第7.0版 14 遵守事項⑧）と役割の設定（14.2）。管理者だけ。
// 最後のログインを出し、使われていない利用者を見つけやすくする。要らない利用者は止める（消さない）。
export const metadata = { title: "ユーザー管理" };

export default async function UsersPage() {
  const config = getConfig();
  if (config.auth.mode !== "local") redirect("/");
  const access = await pageAccess("user.manage");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden" || !access.session.local) {
    return (
      <p role="alert" className="text-label">
        {ADMIN_ONLY}
      </p>
    );
  }
  const users = await listUsers(await authContext());
  // 日時の書式は画面で1つ（`2026/10/20 05:49`。docs/spec.md の 2.2）
  const fmt = { format: (d: Date) => formatDateTimeIn(d.toISOString(), config.timeZone) };
  return (
    <UserAdmin
      csrfToken={access.session.local.row.csrfToken}
      selfId={access.session.local.user.id}
      minPasswordLength={minPasswordLength(config.auth.mfaRequired)}
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
