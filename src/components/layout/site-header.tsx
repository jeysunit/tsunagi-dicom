import Link from "next/link";
import { LockNowButton } from "@/components/auth/lock-guard";
import { LogoutButton } from "@/components/auth/logout-button";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import type { Theme } from "@/lib/preferences";

export interface HeaderUser {
  displayName: string;
  username: string;
  roleLabel: string;
  csrfToken: string;
  canManageUsers: boolean;
}

// どの頁にも出す見出し。「非医療機器」の表示は出さない（承認者の決定。医療機器でない旨は README と仕様書に書く）。
// AUTH_MODE=local でログインしていれば、利用者・役割・ログアウトを出す。
// ログインしていれば（検証モードを含む）、明るい地と暗い地の切り替えを出す。
export function SiteHeader({
  user,
  pendingCsrfToken,
  theme,
}: {
  user?: HeaderUser;
  pendingCsrfToken?: string;
  /** 地の色の切り替え（ログインしているときだけ） */
  theme?: { current: Theme; csrfToken?: string };
}) {
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
        {theme && <ThemeToggle initial={theme.current} csrfToken={theme.csrfToken} />}
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
      </div>
    </header>
  );
}
