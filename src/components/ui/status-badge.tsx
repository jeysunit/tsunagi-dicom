import type * as React from "react";
import { cn } from "@/lib/utils";

// 状態の札（docs/design-system/parts.md の「状態の札」。部品集の `.st`）。12px・高さ 20px・角 3px・枠 1px。
// 文字と形の印を必ず持ち、色は枠と印だけに付ける（文字は本文の色）。色だけで状態を伝えない。状態でないもの（モダリティなど）には使わない。
// 種類の名前は parts.md の `data-k` と同じ（3 製品で 1 つ）。語は呼ぶ側が表のとおりに渡す。
const KINDS = {
  /** ○ 灰：予定・送信待ち・確認待ち・未確認 */
  plan: { mark: "○", border: "border-border-input", markTone: "text-label" },
  /** ◐ warning：実施中 */
  run: { mark: "◐", border: "border-warning", markTone: "text-warning" },
  /** ◔ warning：送信中・受信中 */
  wait: { mark: "◔", border: "border-warning", markTone: "text-warning" },
  /** ◔ warning：確認中（読み込み中） */
  check: { mark: "◔", border: "border-warning", markTone: "text-warning" },
  /** ● success：完了 */
  done: { mark: "●", border: "border-success", markTone: "text-success" },
  /** ✓ success：送信完了・受信完了・確認済・成功・接続中 */
  ok: { mark: "✓", border: "border-success", markTone: "text-success" },
  /** ● success：待ち受け中 */
  listen: { mark: "●", border: "border-success", markTone: "text-success" },
  /** — 灰：取消（文字に取り消し線は引かない） */
  cancel: { mark: "—", border: "border-border-input", markTone: "text-label" },
  /** ■ danger：中止 */
  stop: { mark: "■", border: "border-danger", markTone: "text-danger" },
  /** ✕ danger：送信失敗・確認失敗・失敗・一部が接続不可・停止 */
  ng: { mark: "✕", border: "border-danger", markTone: "text-danger" },
  /** ？ danger の破線：結果不明・確認できません */
  unknown: { mark: "？", border: "border-danger border-dashed", markTone: "text-danger" },
  /** ◇ 灰：知らせ（良し悪しがない） */
  note: { mark: "◇", border: "border-border-input", markTone: "text-label" },
} as const;

export type StatusKind = keyof typeof KINDS;

export function StatusBadge({ kind, className, children, ...props }: { kind: StatusKind; children: React.ReactNode } & React.ComponentProps<"span">) {
  const k = KINDS[kind];
  return (
    <span
      data-slot="status-badge"
      data-k={kind}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-[3px] border bg-background px-1.5 text-xs leading-[18px] whitespace-nowrap text-foreground",
        k.border,
        className,
      )}
      {...props}
    >
      <span aria-hidden className={cn("text-[10px] leading-none", k.markTone)}>
        {k.mark}
      </span>
      <span>{children}</span>
    </span>
  );
}
