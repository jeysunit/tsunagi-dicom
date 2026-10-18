import { ShieldAlert } from "lucide-react";
import Link from "next/link";
import { LockNowButton } from "@/components/auth/lock-guard";
import { LogoutButton } from "@/components/auth/logout-button";

export interface HeaderUser {
  displayName: string;
  username: string;
  roleLabel: string;
  csrfToken: string;
  canManageUsers: boolean;
}

// どの頁にも出す見出し。「非医療機器」の表示はここに1つだけ置く（機能ごとの断り書きは足さない）。
// AUTH_MODE=local でログインしていれば、利用者・役割・ログアウトを出す。
export function SiteHeader({ user, pendingCsrfToken }: { user?: HeaderUser; pendingCsrfToken?: string }) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-surface px-4 py-2">
      <div className="flex items-center gap-4">
        <Link href="/" className="font-bold text-value">
          tsunagi-dicom
        </Link>
        {user && (
          <nav aria-label="頁" className="flex items-center gap-3 text-label">
            <Link href="/" className="hover:text-value">
              検査
            </Link>
            {user.canManageUsers && (
              <Link href="/admin/users" className="hover:text-value">
                利用者
              </Link>
            )}
            <Link href="/account" className="hover:text-value">
              自分の設定
            </Link>
          </nav>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {user && (
          <div className="flex items-center gap-2" data-testid="current-user">
            <span className="text-value">{user.displayName}</span>
            <span className="text-label">
              （{user.username}・{user.roleLabel}）
            </span>
            <LockNowButton />
            <LogoutButton csrfToken={user.csrfToken} />
          </div>
        )}
        {!user && pendingCsrfToken && <LogoutButton csrfToken={pendingCsrfToken} />}
        <p className="flex items-center gap-1.5 text-label" data-testid="not-for-diagnostic-use">
          <ShieldAlert aria-hidden className="size-4" />
          Not for Diagnostic Use / 非医療機器
        </p>
      </div>
    </header>
  );
}
