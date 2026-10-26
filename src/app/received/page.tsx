import { ReceivedList } from "@/components/pacs/received-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { pageAccess } from "@/lib/auth/page-session";
import { audit } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { RECEIVE_LIMIT, receiveLogView, type ReceiveLog } from "@/lib/receive-log";
import { ReceivePeriodError, resolveReceivePeriod, type ReceivePeriod } from "@/lib/receive-period";
import { loadFailed } from "@/lib/ui-text";

// 受け取りの記録の頁（docs/spec.md の 3.3。段 4）。期間（URL の period・from・to。無ければ今日）の中で Orthanc が受け取った検査を、
// 新しい順に 1 件 1 行で出す。いつ（受け取った時刻）・どの機器から（呼んできた AE タイトル）・誰の・何の検査か・画像の数・状態。
// 返した検査は、画面の API と同じく記録してから描く（記録に失敗したら描かない）。
// 時刻は Orthanc から UTC で来るので、サーバーの時間帯（TZ）に直して `2026/10/17 18:01:00` の形で出す。
// 期間の切り替え・絞り込み・ページ送り・新着の印・再読み込みは表の部品（src/components/pacs/received-list.tsx）。

export const metadata = { title: "受信一覧" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

export default async function ReceivedPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await pageAccess("receive.view");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return <EmptyState kind="denied" adminOnly={false} />;
  }
  const { session } = access;
  const { timeZone } = getConfig();
  const params = await searchParams;
  let period: ReceivePeriod;
  let periodError: string | null = null;
  try {
    period = resolveReceivePeriod({ period: first(params.period), from: first(params.from), to: first(params.to) }, timeZone);
  } catch (error) {
    if (!(error instanceof ReceivePeriodError)) throw error;
    // 読めない期間は今日に戻し、何が合わなかったかを知らせる
    periodError = error.message;
    period = resolveReceivePeriod({}, timeZone);
  }
  let log: ReceiveLog;
  try {
    log = await receiveLogView(getBackend(), session.role, period);
    const patients = new Set(log.returned.map((r) => r.patientId));
    await audit(session, {
      action: "receive_log",
      patientId: patients.size === 1 ? [...patients][0]! : null,
      studyInstanceUid: log.returned.length === 1 ? log.returned[0]!.studyInstanceUid : null,
      detail: {
        via: "page",
        period: { kind: period.kind, from: period.from, to: period.to },
        results: log.returned.length,
        overLimit: log.overLimit,
        complete: log.complete,
        returned: log.returned.map((s) => [s.patientId, s.studyInstanceUid]),
      },
    });
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
    <section className="flex min-h-0 flex-1 flex-col gap-3" data-testid="received-page">
      <PageHeader title="受信一覧" />
      <ReceivedList
        initial={{ items: log.items, overLimit: log.overLimit, complete: log.complete, period: { kind: period.kind, from: period.from, to: period.to } }}
        initialError={periodError}
        timeZone={timeZone}
        limit={RECEIVE_LIMIT}
      />
    </section>
  );
}
