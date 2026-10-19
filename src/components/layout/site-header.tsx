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
}

// どの頁にも出す見出し。共通の注意の表示は出さない（承認者の決定。承認・認証を受けていないことと使う場面は README と仕様書に書く）。
// AUTH_MODE=local でログインしていれば、利用者・役割・ログアウトを出す。
// ログインしていれば（検証モードを含む）、明るい地と暗い地の切り替えを出す。
export function SiteHeader({
  user,
  pendingCsrfToken,
  theme,
  nav,
}: {
  user?: HeaderUser;
  pendingCsrfToken?: string;
  /** 頁の道（ログインしているときだけ。検証モードを含む） */
  nav?: {
    canManageUsers: boolean;
    canEditViewerDefaults: boolean;
    account: boolean;
    /** 受け取りの記録（段 4） */
    canViewReceived?: boolean;
    /** 機器の一覧と確かめ（段 4） */
    canCheckModalities?: boolean;
  };
  /** 地の色の切り替え（ログインしているときだけ） */
  theme?: { current: Theme; csrfToken?: string };
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border bg-surface px-6 py-2.5">
      <div className="flex items-center gap-4">
        <Link href="/" className="font-bold text-value">
          tsunagi-dicom
        </Link>
        {nav && (
          <nav aria-label="頁" className="flex items-center gap-4 text-label">
            <Link href="/" className="hover:text-value">
              検査
            </Link>
            {nav.canViewReceived && (
              <Link href="/received" className="hover:text-value">
                受け取り
              </Link>
            )}
            {nav.canCheckModalities && (
              <Link href="/modalities" className="hover:text-value">
                機器
              </Link>
            )}
            {nav.canEditViewerDefaults && (
              <Link href="/admin/viewers" className="hover:text-value">
                ビューアの既定
              </Link>
            )}
            {nav.canManageUsers && (
              <Link href="/admin/users" className="hover:text-value">
                利用者
              </Link>
            )}
            {nav.account && (
              <Link href="/account" className="hover:text-value">
                自分の設定
              </Link>
            )}
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
