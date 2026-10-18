import type { Metadata } from "next";
import { connection } from "next/server";
import { LockGuard } from "@/components/auth/lock-guard";
import { DevModeBand } from "@/components/layout/dev-mode-band";
import { SiteHeader, type HeaderUser } from "@/components/layout/site-header";
import { can, ROLE_LABELS } from "@/lib/auth/roles";
import { getAuthState } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import "./globals.css";

export const metadata: Metadata = {
  title: "tsunagi-dicom",
  description: "Not for Diagnostic Use / 非医療機器",
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
          canManageUsers: can(state.session.role, "user.manage"),
        }
      : undefined;
  // ログインの途中は、頁の道を出さず、ログアウトだけを出す
  const pendingCsrfToken = state.kind === "pending" ? state.row.csrfToken : undefined;

  const main = <main className="px-4 py-4">{children}</main>;
  return (
    <html lang="ja">
      <body className="min-h-screen antialiased">
        {config.auth.mode === "dev" && state.kind === "active" && <DevModeBand role={state.session.role} />}
        <SiteHeader user={user} pendingCsrfToken={pendingCsrfToken} />
        {local ? (
          <LockGuard
            csrfToken={local.row.csrfToken}
            minutes={config.auth.screenLockMinutes}
            needsTotp={local.user.totpSecretEnc !== null}
            initiallyLocked={state.kind === "locked"}
          >
            {main}
          </LockGuard>
        ) : (
          main
        )}
      </body>
    </html>
  );
}
