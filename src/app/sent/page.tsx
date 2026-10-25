import { SentList } from "@/components/pacs/sent-list";
import { pageAccess } from "@/lib/auth/page-session";
import { getConfig } from "@/lib/config";
import { SENT_LIMIT } from "@/lib/sent-log";
import { FORBIDDEN_PAGE } from "@/lib/ui-text";

// 送信一覧の頁（docs/spec.md の 3.4）。tsunagi-dicom が求めた送信を、期間で読んで新しい順に並べる（送受信の一覧の送る側の形。
// docs/design-system/components.md）。読むだけで、書き込みの操作は置かない（再送信は検査の詳細の「送信」から）。
// 表は画面の API（/api/sent-log）から読む（開いたことは、その API が記録する）。

export const metadata = { title: "送信一覧" };

export default async function SentPage() {
  const access = await pageAccess("send.view");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return (
      <p role="alert" className="text-label">
        {FORBIDDEN_PAGE}
      </p>
    );
  }
  return (
    <section className="space-y-3" data-testid="sent-page">
      <h1 className="text-lg font-bold text-value">送信一覧</h1>
      <SentList timeZone={getConfig().timeZone} limit={SENT_LIMIT} />
    </section>
  );
}
