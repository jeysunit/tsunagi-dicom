import { ModalityList } from "@/components/pacs/modality-list";
import { pageAccess } from "@/lib/auth/page-session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import { allowlistFor, modalityView, type ModalityView } from "@/lib/fields";

// 機器の頁（docs/spec.md の 3.3。段 4）。Orthanc に登録された受け元・送り先の機器の一覧と、つながるかの確かめ（C-ECHO）。
// 住所（Host・Port）は、許可の一覧に載った役割にだけ出す（既定では管理者だけ）。
export const metadata = { title: "接続先" };

export default async function ModalitiesPage() {
  const access = await pageAccess("modality.check");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return (
      <p role="alert" className="text-label">
        この役割では機器の一覧を開けない
      </p>
    );
  }
  let modalities: ModalityView[];
  try {
    const allowlist = allowlistFor(access.session.role);
    modalities = (await getBackend().listModalities()).map((m) => modalityView(m, allowlist));
  } catch (error) {
    if (!(error instanceof BackendError)) console.error(error);
    return (
      <p role="alert" className="text-label">
        {error instanceof BackendError ? error.message : "機器の一覧を読めなかった"}
      </p>
    );
  }
  return <ModalityList modalities={modalities} csrfToken={access.session.local?.row.csrfToken} />;
}
