import { ImportScreen } from "@/components/pacs/import-screen";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { pageAccess } from "@/lib/auth/page-session";
import { can } from "@/lib/auth/roles";
import { getConfig } from "@/lib/config";

// インポートの頁（docs/spec.md の 3.5「取り込み」。フェーズ 6）。DICOM のファイル・フォルダを選び、1 件ずつ BFF の
// POST /api/import へ送る。組み方はファイルを選ぶ部品（docs/design-system/parts.md）の 1 つの区画だけ。
// 役割（study.import）と、検証モードの書き込みの止めは、頁でも見る（BFF も 1 件ごとに断る）。

export const metadata = { title: "インポート" };

export default async function ImportPage() {
  const access = await pageAccess("study.import");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return <EmptyState kind="denied" adminOnly={false} />;
  }
  const config = getConfig();
  // 検証モードで書き込みを止めているときは、部品を出さない（帯に「書き込み：無効」が出ている）
  const writes = config.auth.mode !== "dev" || !!config.auth.devAllowWrite;
  // 結果不明を照らせる役割（管理者）には「管理者に確かめを頼んでください。」を出さず、結果不明の行に「確認」を出す
  const canResolve = can(access.session.role, "pacs.reconcile");
  return (
    <section className="space-y-3" data-testid="import-page">
      <PageHeader title="インポート" />
      {writes ? (
        <ImportScreen
          limitBytes={config.screen.importMaxMb * 1024 * 1024}
          csrfToken={access.session.local?.row.csrfToken}
          unknownHelp={canResolve ? "" : undefined}
          canResolve={canResolve}
        />
      ) : (
        <EmptyState fact="書き込みが無効のため、インポートできません。" data-testid="import-disabled" />
      )}
    </section>
  );
}
