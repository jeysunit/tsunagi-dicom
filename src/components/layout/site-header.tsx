import Link from "next/link";
import { LogoutButton } from "@/components/auth/logout-button";
import { ConnStatus } from "@/components/layout/conn-status";
import { HeaderAccount, type HeaderUser } from "@/components/layout/header-account";
import { NavToggle } from "@/components/layout/nav-toggle";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import type { Theme } from "@/lib/preferences";
import { version } from "../../../package.json";

export type { HeaderUser };

// どの頁にも出す上の帯（高さ 48px・地 surface・下に 1px の border・間 12px。docs/design-system/parts.md の「上の帯」）。
// 左から ナビの開閉 → 製品名 → 版。右から 接続の状態 → 表示 → 区切り → 利用者（表示名／ID（役割）の 2 行）→ 画面ロック → ログアウト。無い項目は詰める。
// 画面への道は左のナビ（side-nav.tsx）に置き、ここには置かない。共通の注意の表示は出さない（承認・認証を受けていないことと使う場面は README と仕様書に書く）。
// AUTH_MODE=local でログインしていれば、利用者・画面ロック・ログアウトを出す（画面のロックの間は出さない。header-account.tsx）。
// ログインしていれば（検証モードを含む）、接続の状態と、明るい地と暗い地の切り替えを出す。
export function SiteHeader({
  user,
  pendingCsrfToken,
  theme,
  navToggle,
  connection,
}: {
  user?: HeaderUser;
  pendingCsrfToken?: string;
  /** 左のナビの開け閉めのボタン（左のナビを出す画面だけ） */
  navToggle?: boolean;
  /** 地の色の切り替え（ログインしているときだけ） */
  theme?: { current: Theme; csrfToken?: string };
  /** 接続の状態（見てよい役割にだけ。時刻はこの時間帯で出す） */
  connection?: { timeZone: string };
}) {
  return (
    <header className="flex h-12 items-center gap-3 border-b border-border bg-surface px-4" data-testid="site-header">
      {navToggle && <NavToggle />}
      <Link href="/" className="font-bold text-value">
        tsunagi-dicom
      </Link>
      <span className="text-xs text-label" data-testid="app-version">
        {version}
      </span>
      <span className="flex-1" aria-hidden="true" />
      {connection && <ConnStatus timeZone={connection.timeZone} />}
      {theme && <ThemeToggle initial={theme.current} csrfToken={theme.csrfToken} />}
      {user && <HeaderAccount user={user} />}
      {!user && pendingCsrfToken && <LogoutButton csrfToken={pendingCsrfToken} />}
    </header>
  );
}
