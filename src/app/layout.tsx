import type { Metadata } from "next";
import { connection } from "next/server";
import { LockGuard } from "@/components/auth/lock-guard";
import { DevModeBand } from "@/components/layout/dev-mode-band";
import { buildNavGroups } from "@/components/layout/nav-items";
import { SideNav } from "@/components/layout/side-nav";
import { SiteHeader, type HeaderUser } from "@/components/layout/site-header";
import { screenUnlockNeedsTotp } from "@/lib/auth/local-auth";
import { can, ROLE_LABELS } from "@/lib/auth/roles";
import { getAuthState } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { DEFAULT_THEME, getTheme } from "@/lib/preferences";
import "./globals.css";

// ブラウザのタブの題名は頁ごと（「検査一覧 - tsunagi-dicom」。docs/spec.md の 2.3）。頁は metadata の title に頁の名前だけを書く
export const metadata: Metadata = {
  title: { default: "tsunagi-dicom", template: "%s - tsunagi-dicom" },
  description: "Orthanc の前に置く、日本の現場向けの PACS の画面と中継のサーバー",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // 設定は起動の時に読む。作る時（next build）に先に描かないよう、要求ごとに描く
  await connection();
  const config = getConfig();
  const state = await getAuthState();

  const local = state.kind === "active" || state.kind === "locked" ? state.session.local : undefined;
  const user: HeaderUser | undefined =
    local && (state.kind === "active" || state.kind === "locked")
      ? {
          displayName: local.user.displayName,
          username: local.user.username,
          roleLabel: ROLE_LABELS[state.session.role],
          csrfToken: local.row.csrfToken,
        }
      : undefined;
  // ログインの途中は、頁の道を出さず、ログアウトだけを出す
  const pendingCsrfToken = state.kind === "pending" ? state.row.csrfToken : undefined;

  // 地の色は利用者ごとに覚えたもの（既定は明るい地。docs/spec.md の 2）
  const signedIn = state.kind === "active" || state.kind === "locked" ? state.session : undefined;
  const theme = signedIn ? await getTheme(await getDb(), signedIn.actorId) : DEFAULT_THEME;

  // 左のナビは、ログインしている（検証モードを含む）ときだけ。ロックの間は、ほかの中身と同じく描かない
  const navGroups =
    state.kind === "active"
      ? buildNavGroups({
          canManageUsers: !!local && can(state.session.role, "user.manage"),
          canEditViewerDefaults: can(state.session.role, "viewer.defaults"),
          account: !!local,
          canViewReceived: can(state.session.role, "receive.view"),
          canCheckModalities: can(state.session.role, "modality.check"),
        })
      : undefined;
  // 本文は左寄せで幅いっぱい。幅を絞る型（設定・ログイン）は頁の側で包む（docs/design-system/parts.md の「外枠」）
  const main = <main className="flex min-h-0 w-full flex-1 flex-col px-6 pt-3 pb-6">{children}</main>;
  const content = navGroups ? (
    <div className="flex min-h-0 flex-1">
      <SideNav groups={navGroups} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{main}</div>
    </div>
  ) : (
    main
  );
  return (
    <html lang="ja" data-theme={theme}>
      <body className="group/body flex min-h-dvh flex-col antialiased">
        {config.auth.mode === "dev" && state.kind === "active" && <DevModeBand role={state.session.role} allowWrite={!!config.auth.devAllowWrite} />}
        <SiteHeader
          user={user}
          pendingCsrfToken={pendingCsrfToken}
          theme={state.kind === "active" ? { current: theme, csrfToken: local?.row.csrfToken } : undefined}
          navToggle={!!navGroups}
        />
        {local ? (
          <LockGuard
            csrfToken={local.row.csrfToken}
            minutes={config.auth.screenLockMinutes}
            needsTotp={screenUnlockNeedsTotp(config.auth, local.user)}
            initiallyLocked={state.kind === "locked"}
          >
            {content}
          </LockGuard>
        ) : (
          content
        )}
      </body>
    </html>
  );
}
