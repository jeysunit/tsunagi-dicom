import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

// 知らせ（docs/design-system/parts.md の「知らせ」）。左 4px の状態の色・印・文。色だけで伝えず、印と文を必ず持つ。
// 読み上げは、画面の上の誤りだけ role="alert"（alert を付けた err）。ほかは role="status"。入力欄の下の誤りには使わない。
const KINDS = {
  ok: { Icon: CheckCircle2, bar: "border-l-success", tone: "text-success" },
  warn: { Icon: AlertTriangle, bar: "border-l-warning", tone: "text-warning" },
  err: { Icon: XCircle, bar: "border-l-danger", tone: "text-danger" },
  info: { Icon: Info, bar: "border-l-border-input", tone: "text-label" },
} as const;

export type NoticeKind = keyof typeof KINDS;

export function Notice({
  kind,
  alert = false,
  silent = false,
  className,
  children,
  ...props
}: {
  kind: NoticeKind;
  /** 画面の上の誤りの知らせとして読み上げる（kind が err のときだけ効く） */
  alert?: boolean;
  /** 読み上げの役を付けない。別の読み上げの領域が同じ変化を 1 回伝えるとき（結果不明を記録したあとの結果の知らせ）に使う */
  silent?: boolean;
  children: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "role">) {
  const { Icon, bar, tone } = KINDS[kind];
  return (
    <div
      data-slot="notice"
      data-k={kind}
      role={silent ? undefined : alert && kind === "err" ? "alert" : "status"}
      className={cn("flex items-start gap-2 rounded border border-l-4 border-border bg-surface px-3 py-2 text-sm text-foreground", bar, className)}
      {...props}
    >
      <Icon aria-hidden className={cn("mt-[3px] size-4 shrink-0", tone)} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}
