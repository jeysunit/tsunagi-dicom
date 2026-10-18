import type { Metadata } from "next";
import { connection } from "next/server";
import { DevModeBand } from "@/components/layout/dev-mode-band";
import { SiteHeader } from "@/components/layout/site-header";
import { getSession } from "@/lib/auth/session";
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
  const session = config.auth.mode === "dev" ? await getSession() : null;
  return (
    <html lang="ja">
      <body className="min-h-screen antialiased">
        {session && <DevModeBand role={session.role} allowWrite={config.auth.devAllowWrite} />}
        <SiteHeader />
        <main className="px-4 py-4">{children}</main>
      </body>
    </html>
  );
}
