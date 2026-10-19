"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityView } from "@/lib/fields";

// 機器の一覧とつながるかの確かめ（docs/spec.md の 3.3。段 4）。1 件 1 行。「確かめる」で Orthanc から C-ECHO を送る。
export function ModalityList({ modalities, csrfToken }: { modalities: ModalityView[]; csrfToken?: string }) {
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string } | "busy">>({});
  const showAddress = modalities.some((m) => m.host !== undefined);

  async function echo(id: string) {
    setResults((r) => ({ ...r, [id]: "busy" }));
    const result = await postJson(`/api/modalities/${encodeURIComponent(id)}/echo`, {}, csrfToken);
    const text = result.ok ? (result.data.connected ? "つながった" : "つながらない") : errorText(result);
    setResults((r) => ({ ...r, [id]: { ok: result.ok && result.data.connected === true, text } }));
  }

  return (
    <section className="space-y-2" data-testid="modalities-page">
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h1 className="font-bold text-value">機器</h1>
        <p className="text-xs text-label">Orthanc に登録された受け元・送り先。機器の登録は Orthanc の設定で行う。</p>
      </div>
      {modalities.length === 0 ? (
        <p className="text-label">Orthanc に機器が登録されていない</p>
      ) : (
        <div className="overflow-auto rounded-md border border-border">
          <table className="w-full table-fixed border-collapse" data-testid="modality-table">
            <thead className="bg-surface text-left text-xs text-label">
              <tr className="border-b border-border">
                <th className="px-2 py-1 font-normal">名前</th>
                <th className="px-2 py-1 font-normal">AE タイトル</th>
                {showAddress && <th className="px-2 py-1 font-normal">住所</th>}
                <th className="px-2 py-1 font-normal">つながるか</th>
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
                        <Button type="button" size="xs" variant="outline" disabled={r === "busy"} onClick={() => void echo(id)} data-testid="echo">
                          確かめる
                        </Button>
                        {r && r !== "busy" && (
                          <span role={r.ok ? "status" : "alert"} className={r.ok ? "text-xs text-value" : "text-xs text-danger"} data-testid="echo-result">
                            {r.text}
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
