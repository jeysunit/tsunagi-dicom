import type * as React from "react";
import { cn } from "@/lib/utils";

// 小さな印（docs/design-system/parts.md の「小さな印」。部品集の `.badge`）。12px・高さ 20px・角 3px・枠 1px・字 label。
// 状態ではない印（新着・インポート）だけに使う。印の形も色も持たない。状態は StatusBadge、モダリティは ModalityMark。
export function Badge({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="badge"
      className={cn("inline-flex h-5 items-center rounded-[3px] border border-border bg-background px-1.5 text-xs leading-[18px] whitespace-nowrap text-label", className)}
      {...props}
    />
  );
}
