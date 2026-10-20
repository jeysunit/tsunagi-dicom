import Link from "next/link";
import { LockNowButton } from "@/components/auth/lock-guard";
import { LogoutButton } from "@/components/auth/logout-button";
import { NavLinks } from "@/components/layout/nav-links";
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
      <div className="flex items-center gap-4 self-stretch">
        <Link href="/" className="font-bold text-value">
          tsunagi-dicom
        </Link>
        {nav && (
          <NavLinks
            items={[
              // 頁の名前は docs/spec.md の 2.2 の用語集（タブの題名と同じ）
              { href: "/", label: "検査一覧" },
              ...(nav.canViewReceived ? [{ href: "/received", label: "受信一覧" }] : []),
              ...(nav.canCheckModalities ? [{ href: "/modalities", label: "接続先" }] : []),
              ...(nav.canEditViewerDefaults ? [{ href: "/admin/viewers", label: "ビューア設定" }] : []),
              ...(nav.canManageUsers ? [{ href: "/admin/users", label: "ユーザー管理" }] : []),
              ...(nav.account ? [{ href: "/account", label: "個人設定" }] : []),
            ]}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {theme && <ThemeToggle initial={theme.current} csrfToken={theme.csrfToken} />}
        {user && (
          <div className="flex items-center gap-2" data-testid="current-user">
            <span className="text-value">{user.displayName}</span>
            <span className="text-label">
              {user.username}（{user.roleLabel}）
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
