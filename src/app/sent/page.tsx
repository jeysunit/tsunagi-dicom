import { SentList } from "@/components/pacs/sent-list";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { pageAccess } from "@/lib/auth/page-session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { SENT_LIMIT } from "@/lib/sent-log";

// 送信一覧の頁（docs/spec.md の 3.4）。tsunagi-dicom が求めた送信を、期間で読んで新しい順に並べる（送受信の一覧の送る側の形。
// docs/design-system/components.md）。読むだけで、書き込みの操作は置かない（再送信は検査の詳細の「送信」から）。
// 表は画面の API（/api/sent-log）から読む（開いたことは、その API が記録する）。

export const metadata = { title: "送信一覧" };

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;

/**
 * URL の `aet`（接続先の詳細の「送信一覧で全部見る」。docs/design-system/components.md の「接続先の詳細」）を、
 * 送信先の欄の値（登録した名称）にする。登録に無い AE タイトルなら絞らない（読めなかったときも同じ）
 */
async function destinationOf(aet: string | null): Promise<string> {
  if (!aet) return "";
  try {
    return (await getBackend().listModalities()).find((m) => m.aet === aet)?.id ?? "";
  } catch (error) {
    if (!(error instanceof BackendError)) console.error(error);
    return "";
  }
}

export default async function SentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await pageAccess("send.view");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return <EmptyState kind="denied" adminOnly={false} />;
  }
  const initialDestination = await destinationOf(first((await searchParams).aet));
  return (
    <section className="space-y-3" data-testid="sent-page">
      <PageHeader title="送信一覧" />
      <SentList timeZone={getConfig().timeZone} limit={SENT_LIMIT} initialDestination={initialDestination} />
    </section>
  );
}
