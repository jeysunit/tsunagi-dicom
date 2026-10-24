import Link from "next/link";
import { LockNowButton } from "@/components/auth/lock-guard";
import { LogoutButton } from "@/components/auth/logout-button";
import { NavToggle } from "@/components/layout/nav-toggle";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import type { Theme } from "@/lib/preferences";

export interface HeaderUser {
  displayName: string;
  username: string;
  roleLabel: string;
  csrfToken: string;
}

// どの頁にも出す上の帯（高さ 48px。docs/design-system/menu.md）。画面への道は左のナビ（side-nav.tsx）に置き、ここには置かない。
// どの頁にも出す見出し。共通の注意の表示は出さない（承認者の決定。承認・認証を受けていないことと使う場面は README と仕様書に書く）。
// AUTH_MODE=local でログインしていれば、利用者・役割・ログアウトを出す。
// ログインしていれば（検証モードを含む）、明るい地と暗い地の切り替えを出す。
export function SiteHeader({
  user,
  pendingCsrfToken,
  theme,
  navToggle,
}: {
  user?: HeaderUser;
  pendingCsrfToken?: string;
  /** 左のナビの開け閉めのボタン（左のナビを出す画面だけ） */
  navToggle?: boolean;
  /** 地の色の切り替え（ログインしているときだけ） */
  theme?: { current: Theme; csrfToken?: string };
}) {
  return (
    <header className="flex min-h-12 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-border bg-surface px-4 py-1.5">
      <div className="flex items-center gap-3">
        {navToggle && <NavToggle />}
        <Link href="/" className="font-bold text-value">
          tsunagi-dicom
        </Link>
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
