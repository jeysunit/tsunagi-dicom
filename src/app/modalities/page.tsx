import { ModalityList } from "@/components/pacs/modality-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { pageAccess } from "@/lib/auth/page-session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { allowlistFor, modalityView, type ModalityView } from "@/lib/fields";
import { loadFailed } from "@/lib/ui-text";

// 機器の頁（docs/spec.md の 3.3。段 4）。Orthanc に登録された受け元・送り先の機器の一覧と、つながるかの確かめ（C-ECHO）。
// 住所（Host・Port）は、許可の一覧に載った役割にだけ出す（既定では管理者だけ）。
export const metadata = { title: "接続先" };

export default async function ModalitiesPage() {
  const access = await pageAccess("modality.check");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return <EmptyState kind="denied" adminOnly={false} />;
  }
  let modalities: ModalityView[];
  try {
    const allowlist = allowlistFor(access.session.role);
    modalities = (await getBackend().listModalities()).map((m) => modalityView(m, allowlist));
  } catch (error) {
    if (!(error instanceof BackendError)) console.error(error);
    return (
      <>
        <PageHeader title="接続先" className="mb-3" />
        <Notice kind="err" alert>
          {error instanceof BackendError ? error.message : loadFailed("接続先")}
        </Notice>
      </>
    );
  }
  return <ModalityList modalities={modalities} csrfToken={access.session.local?.row.csrfToken} timeZone={getConfig().timeZone} />;
}
