import type * as React from "react";
import { cn } from "@/lib/utils";

// 状態の札（docs/design-system/components.md）。文字と形の印を必ず持ち、色は枠と印だけに付ける（文字は本文の色）。
// 色だけで状態を伝えない。状態でないもの（モダリティなど）には使わない。
const KINDS = {
  /** まだ始まっていない */
  planned: { mark: "○", border: "border-border-input", markTone: "text-label", extra: "" },
  /** 始まっていて終わっていない */
  active: { mark: "◐", border: "border-warning", markTone: "text-warning", extra: "" },
  /** 終わった */
  done: { mark: "●", border: "border-success", markTone: "text-success", extra: "" },
  /** なくなった（灰と「—」で示す。文字に取り消し線は引かない。承認者の決定 2026-10-24） */
  canceled: { mark: "—", border: "border-border-input", markTone: "text-label", extra: "" },
  /** 途中でやめた */
  stopped: { mark: "■", border: "border-danger", markTone: "text-danger", extra: "" },
  /** 送っている途中 */
  sending: { mark: "◔", border: "border-warning", markTone: "text-warning", extra: "" },
  /** 送れた・確かめた */
  confirmed: { mark: "✓", border: "border-success", markTone: "text-success", extra: "" },
  /** 送れなかった */
  failed: { mark: "✕", border: "border-danger", markTone: "text-danger", extra: "" },
  /** 届いたか分からない（破線） */
  unknown: { mark: "？", border: "border-danger border-dashed", markTone: "text-danger", extra: "" },
  /** 知らせだけで、良し悪しがない */
  notice: { mark: "◇", border: "border-border-input", markTone: "text-label", extra: "" },
} as const;

export type StatusKind = keyof typeof KINDS;

export function StatusBadge({ kind, className, children, ...props }: { kind: StatusKind; children: React.ReactNode } & React.ComponentProps<"span">) {
  const k = KINDS[kind];
  return (
    <span
      data-slot="status-badge"
      data-kind={kind}
      className={cn("inline-flex items-center gap-1 rounded-[3px] border px-1 text-xs whitespace-nowrap text-foreground", k.border, className)}
      {...props}
    >
      <span aria-hidden className={k.markTone}>
        {k.mark}
      </span>
      <span className={k.extra}>{children}</span>
    </span>
  );
}
