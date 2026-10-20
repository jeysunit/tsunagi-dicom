import Link from "next/link";
import { pageAccess } from "@/lib/auth/page-session";
import { audit } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import type { ReceivedView } from "@/lib/fields";
import { getConfig } from "@/lib/config";
import { formatDateTimeIn, formatSlashDate } from "@/lib/format/japanese-date";
import { RECEIVE_LIMIT, receiveLogView } from "@/lib/receive-log";
import { cn } from "@/lib/utils";

// 受け取りの記録の頁（docs/spec.md の 3.3。段 4）。Orthanc が受け取った検査を、新しい順に 1 件 1 行で出す。
// いつ（受け取った時刻）・どの機器から（呼んできた AE タイトル）・何件（画像の数）・どの検査か。
// 返した検査は、画面の API と同じく記録してから描く（記録に失敗したら描かない）。
// 時刻は Orthanc から UTC で来るので、サーバーの時間帯（TZ）に直して `2026/10/17 18:01:00` の形で出す。

export const metadata = { title: "受信一覧" };

const CELL = "h-7 px-2 py-0 overflow-hidden text-ellipsis whitespace-nowrap";

/** 入った道。DICOM の C-STORE 以外（REST で入れたなど）は「取り込み」と分かるようにする */
function originText(origin: string | null | undefined): string {
  if (origin === "DicomProtocol") return "";
  if (origin === "RestApi") return "取り込み";
  return origin ?? "";
}

export default async function ReceivedPage() {
  const access = await pageAccess("receive.view");
  if (access.kind === "locked") return null;
  if (access.kind === "forbidden") {
    return (
      <p role="alert" className="text-label">
        この役割では受け取りの記録を開けない
      </p>
    );
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
      <p role="alert" className="text-label">
        {error instanceof BackendError ? error.message : "受け取りの記録を読めなかった"}
      </p>
    );
  }

  return (
    <section className="space-y-2" data-testid="received-page">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h1 className="text-lg font-bold text-value">受け取りの記録</h1>
        <p className="text-xs text-label">
          Orthanc の変更の記録から読める範囲の、新しい {RECEIVE_LIMIT} 件まで。古い記録は Orthanc に残らないことがある。
        </p>
      </div>
      {!complete && (
        <p role="status" className="text-xs text-danger" data-testid="received-incomplete">
          ここまでしか読めていない（変更の記録を、読む範囲の終わりまで読み切れなかった）。抜けた受け取りは、Orthanc で確かめる。
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-label">受け取った検査が無い</p>
      ) : (
        <div className="overflow-auto rounded-md border border-border">
          <table className="w-full min-w-[960px] table-fixed border-collapse" data-testid="received-table">
            <colgroup>
              {/* 受信日時（秒まで）とリンクの列は、値が切れない幅にする */}
              <col style={{ width: 176 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 100 }} />
              <col />
              <col style={{ width: 132 }} />
            </colgroup>
            <thead className="bg-surface text-left text-xs text-label">
              <tr className="border-b border-border">
                <th className="px-2 py-1 font-normal">受け取った時刻</th>
                <th className="px-2 py-1 font-normal">送ってきた機器（AE）</th>
                <th className="px-2 py-1 text-right font-normal">画像</th>
                <th className="px-2 py-1 font-normal">患者 ID</th>
                <th className="px-2 py-1 font-normal">氏名</th>
                <th className="px-2 py-1 font-normal">検査日</th>
                <th className="px-2 py-1 font-normal">モダリティ・検査の記述</th>
                <th className="px-2 py-1 font-normal">
                  <span className="sr-only">開く</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((r, i) => {
                const desc = [r.study.modalities?.join("・"), r.study.studyDescription].filter(Boolean).join(" ");
                const origin = originText(r.origin);
                return (
                  <tr key={`${r.study.studyInstanceUid ?? "row"}-${i}`} className="border-b border-border last:border-0" data-testid="received-row">
                    <td className={CELL} data-testid="received-at">
                      {formatDateTimeIn(r.receivedAt, timeZone, { seconds: true })}
                    </td>
                    <td className={cn(CELL, "font-mono")} title={r.remoteAet ?? origin}>
                      {r.remoteAet ?? <span className="text-label">{origin || "—"}</span>}
                    </td>
                    <td className={cn(CELL, "text-right")}>{r.receivedInstances ?? ""}</td>
                    <td className={cn(CELL, "font-mono")} title={r.study.patientId}>
                      {r.study.patientId}
                    </td>
                    <td className={CELL} title={r.study.patientName}>
                      {r.study.patientName}
                    </td>
                    <td className={CELL}>{formatSlashDate(r.study.studyDate)}</td>
                    <td className={CELL} title={desc}>
                      {origin && (
                        <span className="mr-1.5 rounded border border-border px-1 text-xs text-label" data-testid="received-origin">
                          {origin}
                        </span>
                      )}
                      {desc}
                    </td>
                    <td className={CELL}>
                      {r.study.patientId && (
                        <Link href={`/?${new URLSearchParams({ q: r.study.patientId })}`} className="text-link underline underline-offset-2 hover:decoration-2">
                          一覧で開く
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
