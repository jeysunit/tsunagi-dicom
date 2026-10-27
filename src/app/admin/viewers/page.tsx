import { ViewerDefaults } from "@/components/admin/viewer-defaults";
import { EmptyState } from "@/components/ui/empty-state";
import { pageAccess } from "@/lib/auth/page-session";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { modalityDefaults } from "@/lib/viewer-memory";
import { availableViewers } from "@/lib/viewers";

// モダリティごとの既定のビューアを変える管理の画面（docs/spec.md の 3.2）。管理者だけ。
export const metadata = { title: "ビューア設定" };

export default async function ViewerDefaultsPage() {
  const access = await pageAccess("viewer.defaults");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return <EmptyState kind="denied" />;
  }
  return (
    <ViewerDefaults
      defaults={await modalityDefaults(await getDb())}
      viewers={availableViewers(getConfig().viewers)}
      csrfToken={access.session.local?.row.csrfToken}
    />
  );
}
