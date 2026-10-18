import { StudyBrowser } from "@/components/studies/study-browser";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { pageAccess } from "@/lib/auth/page-session";
import { can } from "@/lib/auth/roles";
import { audit } from "@/lib/auth/session";
import { BackendError } from "@/lib/backend/types";
import { screenDeps } from "@/lib/screen-deps";
import { searchAuditFields } from "@/lib/search-audit";
import { parseFilter } from "@/lib/study-filter";
import { listStudies, type StudyListResult } from "@/lib/study-list";

// 検査の一覧の頁（docs/spec.md の 3.1）。最初の描画はサーバーの側で画面の API と同じ一覧を取り、
// 後の絞り込み・状態の変更は画面（TanStack Query）が画面の API から取る。
// 項目は役割の許可の一覧で絞ったもの（src/lib/fields.ts）。

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await pageAccess("study.search");
  // 画面のロック中は中身を描かない（ロックの画面は layout が出す）
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return (
      <p role="alert" className="text-label">
        この役割では検査の一覧を開けない
      </p>
    );
  }
  const { session } = access;
  const filter = parseFilter(await searchParams);
  const deps = await screenDeps(session);

  let result: StudyListResult;
  try {
    result = await listStudies(deps, filter);
  } catch (error) {
    const message = error instanceof BackendError ? error.message : "検査を読めなかった";
    if (!(error instanceof BackendError)) console.error(error);
    return (
      <p role="alert" className="text-label">
        {message}
      </p>
    );
  }
  await audit(session, searchAuditFields("page", result.returned));

  const role = session.role;
  const screen: ScreenInfo = {
    csrfToken: session.local?.row.csrfToken,
    viewers: deps.viewers,
    can: {
      inspect: can(role, "study.inspect"),
      readStatus: can(role, "study.read_status"),
      urgent: can(role, "study.urgent"),
      bookmark: can(role, "study.bookmark"),
      rememberViewer: can(role, "viewer.remember"),
      allValues: can(role, "dicom.all_values"),
    },
  };

  return (
    <>
      {deps.backend.mock && <p className="mb-3 text-xs text-label">モックのバックエンド</p>}
      <StudyBrowser initialFilter={filter} initialData={{ count: result.count, studies: result.studies }} screen={screen} />
    </>
  );
}
