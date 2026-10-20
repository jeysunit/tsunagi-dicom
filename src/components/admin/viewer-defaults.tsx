"use client";

import { useState } from "react";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityGroup } from "@/lib/modalities";
import type { ViewerInfo } from "@/lib/viewers";

// モダリティごとの既定のビューア（docs/spec.md の 3.2）。選んだらすぐ保存する。
export function ViewerDefaults({
  defaults,
  viewers,
  csrfToken,
}: {
  defaults: Record<ModalityGroup, string | null>;
  viewers: ViewerInfo[];
  csrfToken?: string;
}) {
  const [values, setValues] = useState(defaults);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const openers = viewers.filter((v) => v.kind === "open");

  async function save(modality: ModalityGroup, viewer: string) {
    const before = values[modality];
    setValues({ ...values, [modality]: viewer });
    const result = await postJson("/api/admin/viewer-defaults", { modality, viewer }, csrfToken);
    if (!result.ok) {
      setValues((v) => ({ ...v, [modality]: before }));
      setMessage({ ok: false, text: errorText(result) });
    } else {
      setMessage({ ok: true, text: `${modality} の既定ビューアを保存しました` });
    }
  }

  return (
    <section className="max-w-xl space-y-4">
      <h1 className="text-lg font-bold text-value">ビューア設定（モダリティ別）</h1>
      <p className="text-label">検査ごとの指定がない場合に使うビューアです</p>
      {openers.length === 0 && <p className="text-label">ビューアが設定されていません（VIEWER_OHIF_URL などを設定します）</p>}
      <dl className="divide-y divide-border rounded-md border border-border">
        {(Object.keys(values) as ModalityGroup[]).map((m) => (
          <div key={m} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <dt className="font-bold text-value">{m}</dt>
            <dd>
              <select
                aria-label={`${m} の既定のビューア`}
                className="h-8 rounded-md border border-border bg-background px-2 text-value"
                value={values[m] ?? ""}
                disabled={openers.length === 0}
                onChange={(e) => void save(m, e.target.value)}
              >
                {values[m] === null && <option value="">（未設定）</option>}
                {values[m] !== null && !openers.some((v) => v.id === values[m]) && (
                  <option value={values[m] ?? ""}>{values[m]}（無効）</option>
                )}
                {openers.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </dd>
          </div>
        ))}
      </dl>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm text-label" : "text-sm text-danger"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
