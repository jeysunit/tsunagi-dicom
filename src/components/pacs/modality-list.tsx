"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { useState } from "react";
import { ActionButton } from "@/components/ui/pending";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityView } from "@/lib/fields";
import { formatDateTimeIn } from "@/lib/format/japanese-date";

// 接続先の一覧と接続確認（docs/spec.md の 3.3。段 4）。1 件 1 行。「接続確認」で Orthanc から C-ECHO を送る。
// 結果は印と時刻つきで出す（「成功 10:32:05」「失敗 10:32:11（応答なし）」）。画面の言葉は docs/spec.md の 2.2。

interface EchoResult {
  ok: boolean;
  /** 確かめた時刻（`10:32:05`） */
  at: string;
  /** 失敗の理由（相手が答えない・Orthanc が断った） */
  reason?: string;
}

export function ModalityList({ modalities, csrfToken, timeZone }: { modalities: ModalityView[]; csrfToken?: string; timeZone: string }) {
  const [results, setResults] = useState<Record<string, EchoResult | "busy">>({});
  const showAddress = modalities.some((m) => m.host !== undefined);

  async function echo(id: string) {
    setResults((r) => ({ ...r, [id]: "busy" }));
    const result = await postJson(`/api/modalities/${encodeURIComponent(id)}/echo`, {}, csrfToken);
    const at = formatDateTimeIn(new Date().toISOString(), timeZone, { seconds: true }).split(" ")[1] ?? "";
    const ok = result.ok && result.data.connected === true;
    const reason = ok ? undefined : result.ok ? "応答なし" : errorText(result);
    setResults((r) => ({ ...r, [id]: { ok, at, reason } }));
  }

  return (
    <section className="space-y-2" data-testid="modalities-page">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h1 className="text-lg font-bold text-value">接続先</h1>
        <p className="text-xs text-label">Orthanc に登録された DICOM 接続先（登録・変更は Orthanc の設定で行います）</p>
      </div>
      {modalities.length === 0 ? (
        <p className="text-label">接続先が登録されていません</p>
      ) : (
        <div className="overflow-auto rounded-md border border-border">
          <table className="w-full table-fixed border-collapse" data-testid="modality-table">
            <thead className="bg-surface text-left text-xs text-label">
              <tr className="border-b border-border">
                <th className="px-2 py-1 font-normal">名称</th>
                <th className="px-2 py-1 font-normal">AE タイトル</th>
                {showAddress && <th className="px-2 py-1 font-normal">ホスト:ポート</th>}
                <th className="px-2 py-1 font-normal">接続確認</th>
              </tr>
            </thead>
            <tbody>
              {modalities.map((m) => {
                const id = m.id ?? "";
                const r = results[id];
                return (
                  <tr key={id} className="border-b border-border last:border-0" data-testid="modality-row" data-modality={id}>
                    <td className="h-7 px-2 py-0 font-bold text-value">{id}</td>
                    <td className="h-7 px-2 py-0 font-mono">{m.aet}</td>
                    {showAddress && (
                      <td className="h-7 px-2 py-0 font-mono text-label">
                        {m.host}
                        {m.port != null ? `:${m.port}` : ""}
                      </td>
                    )}
                    <td className="h-7 px-2 py-0">
                      <span className="flex items-center gap-2">
                        <ActionButton type="button" size="xs" variant="outline" pending={r === "busy"} onClick={() => void echo(id)} data-testid="echo">
                          接続確認
                        </ActionButton>
                        {r && r !== "busy" && (
                          <span
                            role={r.ok ? "status" : "alert"}
                            className={r.ok ? "flex items-center gap-1 text-xs text-success" : "flex items-center gap-1 text-xs text-danger"}
                            data-testid="echo-result"
                            data-ok={r.ok}
                          >
                            {r.ok ? <CheckCircle2 aria-hidden className="size-3.5" /> : <XCircle aria-hidden className="size-3.5" />}
                            {r.ok ? `成功 ${r.at}` : `失敗 ${r.at}（${r.reason}）`}
                          </span>
                        )}
                      </span>
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
