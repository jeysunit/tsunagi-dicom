import { ReceivedList } from "@/components/pacs/received-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { pageAccess } from "@/lib/auth/page-session";
import { audit } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import type { ReceivedView } from "@/lib/fields";
import { getConfig } from "@/lib/config";
import { RECEIVE_LIMIT, receiveLogView } from "@/lib/receive-log";
import { loadFailed } from "@/lib/ui-text";

// 受け取りの記録の頁（docs/spec.md の 3.3。段 4）。Orthanc が受け取った検査を、新しい順に 1 件 1 行で出す。
// いつ（受け取った時刻）・どの機器から（呼んできた AE タイトル）・何件（画像の数）・どの検査か。
// 返した検査は、画面の API と同じく記録してから描く（記録に失敗したら描かない）。
// 時刻は Orthanc から UTC で来るので、サーバーの時間帯（TZ）に直して `2026/10/17 18:01:00` の形で出す。
// 絞り込み・新着の印・再読み込みは表の部品（src/components/pacs/received-list.tsx）。

export const metadata = { title: "受信一覧" };

export default async function ReceivedPage() {
  const access = await pageAccess("receive.view");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return <EmptyState kind="denied" adminOnly={false} />;
  }
  const { session } = access;
  const { timeZone } = getConfig();
  let items: ReceivedView[];
  let complete: boolean;
  try {
    const result = await receiveLogView(getBackend(), session.role);
    const patients = new Set(result.returned.map((r) => r.patientId));
    await audit(session, {
      action: "receive_log",
      patientId: patients.size === 1 ? [...patients][0]! : null,
      studyInstanceUid: result.returned.length === 1 ? result.returned[0]!.studyInstanceUid : null,
      detail: {
        via: "page",
        results: result.returned.length,
        complete: result.complete,
        returned: result.returned.map((s) => [s.patientId, s.studyInstanceUid]),
      },
    });
    items = result.items;
    complete = result.complete;
  } catch (error) {
    if (!(error instanceof BackendError)) console.error(error);
    return (
      <>
        <PageHeader title="受信一覧" className="mb-3" />
        <Notice kind="err" alert>
          {error instanceof BackendError ? error.message : loadFailed("受信一覧")}
        </Notice>
      </>
    );
  }

  return (
    <section className="space-y-2" data-testid="received-page">
      <PageHeader title="受信一覧" />
      <ReceivedList initialItems={items} initialComplete={complete} timeZone={timeZone} limit={RECEIVE_LIMIT} />
    </section>
  );
}
