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
      <dl className="space-y-2" data-testid="version-info">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <dt className="text-label">アプリ</dt>
          <dd className="font-bold text-value">tsunagi-dicom</dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <dt className="text-label">バージョン</dt>
          <dd className="font-bold text-value" data-testid="app-version">
            {info.version}
          </dd>
        </div>
        {info.commit && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <dt className="text-label">ビルド</dt>
            <dd className="font-mono font-bold text-value" data-testid="build-commit">
              {info.commit}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
