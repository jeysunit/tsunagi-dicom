import { StudyBrowser } from "@/components/studies/study-browser";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { pageAccess } from "@/lib/auth/page-session";
import { can } from "@/lib/auth/roles";
import { audit } from "@/lib/auth/session";
import { isDicomUid } from "@/lib/backend/relay-path";
import { BackendError } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { screenDeps } from "@/lib/screen-deps";
import { searchAuditFields } from "@/lib/search-audit";
import { parseFilter } from "@/lib/study-filter";
import { listStudies, type StudyListResult } from "@/lib/study-list";
import { FORBIDDEN_PAGE, loadFailed } from "@/lib/ui-text";

// 検査の一覧の頁（docs/spec.md の 3.1）。最初の描画はサーバーの側で画面の API と同じ一覧を取り、
// 後の絞り込み・ビューアの覚えの変更は画面（TanStack Query）が画面の API から取る。
// 項目は役割の許可の一覧で絞ったもの（src/lib/fields.ts）。

// 根の頁は根の layout と同じ段なので、layout の title.template が当たらない。題名を全部書く
export const metadata = { title: { absolute: "検査一覧 - tsunagi-dicom" } };

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await pageAccess("study.search");
  // 画面のロック中は中身を描かない（ロックの画面は layout が出す）
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return (
      <p role="alert" className="text-label">
        {FORBIDDEN_PAGE}
      </p>
    );
  }
  const { session } = access;
  const params = await searchParams;
  const filter = parseFilter(params);
  // 受信一覧の「検査一覧で表示」から開いたとき：その検査を選んだ形で開く（UID の形を確かめ、一覧にあるときだけ選ぶ。
  // 選ぶと、行をクリックしたときと同じく詳細を読み、「詳細を開いた」を記録する）。URL からは、開いた後に外す
  const studyUid = typeof params.studyUid === "string" && isDicomUid(params.studyUid) ? params.studyUid : undefined;
  const deps = await screenDeps(session);

  let result: StudyListResult;
  try {
    result = await listStudies(deps, filter);
  } catch (error) {
    const message = error instanceof BackendError ? error.message : loadFailed("検査");
    if (!(error instanceof BackendError)) console.error(error);
    return (
      <p role="alert" className="text-label">
        {message}
      </p>
    );
  }
  await audit(session, searchAuditFields("page", result.returned, result.facetAudit));

  const role = session.role;
  const config = getConfig();
  // 検証モードで書き込みを止めているときは、書き込みの操作のボタンを出さない（BFF の側でも断る）
  const writes = config.auth.mode !== "dev" || !!config.auth.devAllowWrite;
  const screen: ScreenInfo = {
    csrfToken: session.local?.row.csrfToken,
    viewers: deps.viewers,
    timeZone: config.timeZone,
    can: {
      rememberViewer: can(role, "viewer.remember"),
      allValues: can(role, "dicom.all_values"),
      send: can(role, "study.send") && writes,
      reconcile: can(role, "pacs.reconcile"),
      export: can(role, "study.export") && writes,
      delete: can(role, "study.delete") && writes,
    },
    ...(session.local ? { reauth: true } : {}),
  };

  return (
    <>
      {deps.backend.mock && <p className="mb-3 text-xs text-label">バックエンド：モック</p>}
      <StudyBrowser
        initialFilter={filter}
        initialData={{ count: result.count, studies: result.studies, facets: result.facets }}
        initialDataAt={result.fetchedAt}
        initialSelected={studyUid && result.studies.some((s) => s.studyInstanceUid === studyUid) ? studyUid : undefined}
        screen={screen}
      />
    </>
  );
}
