import { PageHeader } from "@/components/ui/page-header";
import { pageAccess } from "@/lib/auth/page-session";
import { readBuildInfo } from "@/lib/build-info";

// アプリの名前・版・ビルドの commit を読む頁（左のナビの管理の群。docs/spec.md の 2.3）。読むだけで秘密を含まないので、役割では絞らない。
export const metadata = { title: "バージョン情報" };

export default async function VersionPage() {
  const access = await pageAccess();
  if (access.kind === "locked") return null;
  const info = readBuildInfo();
  return (
    <section className="max-w-[var(--w-settings)] space-y-6">
      <PageHeader title="バージョン情報" />
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1" data-testid="version-info">
        <dt className="text-xs leading-5 text-label">アプリ</dt>
        <dd className="font-bold text-value">tsunagi-dicom</dd>
        <dt className="text-xs leading-5 text-label">バージョン</dt>
        <dd className="font-bold text-value" data-testid="app-version">
          {info.version}
        </dd>
        {info.commit && (
          <>
            <dt className="text-xs leading-5 text-label">ビルド</dt>
            <dd className="break-all font-mono text-[13px] font-bold leading-5 text-value" data-testid="build-commit">
              {info.commit}
            </dd>
          </>
        )}
      </dl>
    </section>
  );
}
