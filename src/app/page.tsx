import { StudyBrowser } from "@/components/studies/study-browser";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { pageAccess } from "@/lib/auth/page-session";
import { can } from "@/lib/auth/roles";
import { audit } from "@/lib/auth/session";
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
  const filter = parseFilter(await searchParams);
  const deps = await screenDeps(session);
  const config = getConfig();
  const refreshSeconds = config.screen.studyListRefreshSeconds;

  let result: StudyListResult;
  let version: string | undefined;
  try {
    // 自動更新の基準の版は、一覧を取る前に読む（間に入った検査は、次の版の読み取りで拾う）。
    // 版を読めなくても一覧は出す（画面が最初に読んだ版を基準にする）
    version = refreshSeconds > 0 ? await deps.backend.studyListVersion().catch(() => undefined) : undefined;
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
  // 検証モードで書き込みを止めているときは、書き込みの操作のボタンを出さない（BFF の側でも断る）
  const writes = config.auth.mode !== "dev" || !!config.auth.devAllowWrite;
  const screen: ScreenInfo = {
    csrfToken: session.local?.row.csrfToken,
    viewers: deps.viewers,
    timeZone: config.timeZone,
    refreshSeconds,
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
        initialVersion={version}
        screen={screen}
      />
    </>
  );
}
