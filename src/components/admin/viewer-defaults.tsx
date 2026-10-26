"use client";

import { useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/ui/status-badge";
import { getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import type { ModalityGroup } from "@/lib/modalities";
import type { ViewerInfo } from "@/lib/viewers";

// モダリティごとの既定のビューア（docs/spec.md の 3.2）。選んだらすぐ保存し、欄の横に「保存しました」の札を 3 秒出す
// （docs/design-system/parts.md の「保存」）。

/** 「保存しました」の札を出す時間（ミリ秒） */
const SAVED_BADGE_MS = 3000;
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
  /** 保存に失敗したときの 1 行（次の保存の成功で消す） */
  const [error, setError] = useState<string | null>(null);
  /** 保存の要求を出している間の行 */
  const [saving, setSaving] = useState<ModalityGroup | null>(null);
  /** 「保存しました」の札を出している行（3 秒） */
  const [saved, setSaved] = useState<ModalityGroup | null>(null);
  const savedTimer = useRef<number | undefined>(undefined);
  const openers = viewers.filter((v) => v.kind === "open");

  useEffect(() => () => window.clearTimeout(savedTimer.current), []);

  // 値を 1 つ替える欄なので、選んだらすぐ保存する。断られたら元の値に戻して理由を出す（札は出さない）。
  // 結果が分からないとき（通信の失敗・5xx）は、保存済みの値を読んで照らし合わせる
  async function save(modality: ModalityGroup, viewer: string) {
    // 保存の要求を出している間は、ほかの選び直しを受けない（欄の動きを止めず、古い答えで値が戻らないようにする）
    if (saving) return;
    const before = values[modality];
    window.clearTimeout(savedTimer.current);
    setSaved(null);
    setError(null);
    setSaving(modality);
    setValues((v) => ({ ...v, [modality]: viewer }));
    const result = await postJson("/api/admin/viewer-defaults", { modality, viewer }, csrfToken);
    let stored: boolean | null = result.ok;
    if (!result.ok && (result.status === 0 || result.status >= 500)) {
      // 答えが届かない・中で失敗した：サーバーに書けたかは分からない。いまの値を読んで照らし合わせる（読めなければ不明のまま）
      stored = await readStored(modality, viewer);
    }
    setSaving(null);
    if (stored === true) {
      setSaved(modality);
      savedTimer.current = window.setTimeout(() => setSaved(null), SAVED_BADGE_MS);
    } else if (stored === false) {
      setValues((v) => ({ ...v, [modality]: before }));
      setError(errorText(result));
    } else {
      // 書けたか確かめられない：元の値へ戻したと断定しない（画面と保存済みの値がずれていないか、読み直して確かめてもらう）
      setError("保存できたか確認できませんでした。ページを読み直して、設定を確かめてください");
    }
  }

  /** 保存済みの値を読み、いま選んだ値と同じか。読めなければ null */
  async function readStored(modality: ModalityGroup, viewer: string): Promise<boolean | null> {
    try {
      const r = await getJson<{ defaults: Record<string, string | null> }>("/api/admin/viewer-defaults");
      return r.defaults[modality] === viewer;
    } catch {
      return null;
    }
  }

  return (
    <section className="max-w-[var(--w-settings)] space-y-4">
      <h1 className="text-lg font-bold text-value">ビューア設定（モダリティ別）</h1>
      <p className="text-label">検査ごとの指定がない場合に使うビューアです</p>
      {openers.length === 0 && <p className="text-label">ビューアが設定されていません（VIEWER_OHIF_URL などを設定します）</p>}
      <dl className="divide-y divide-border rounded-md border border-border">
        {(Object.keys(values) as ModalityGroup[]).map((m) => (
          <div key={m} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <dt className="font-bold text-value">{m}</dt>
            <dd className="flex items-center gap-2">
              {/* 札の場所は欄の左に取っておき、出入りで欄を動かさない */}
              <span className="inline-flex min-w-[6.5rem] justify-end" aria-live="polite">
                {saved === m && <StatusBadge kind="confirmed">保存しました</StatusBadge>}
              </span>
              <select
                aria-label={`${m} の標準のビューア`}
                className="h-8 rounded-md border border-border-input bg-background px-2 text-value"
                value={values[m] ?? ""}
                disabled={openers.length === 0}
                aria-busy={saving === m || undefined}
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
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
