import type * as React from "react";
import { cn } from "@/lib/utils";

// 選択欄（docs/design-system/parts.md の「入力欄」）。標準の select をそのまま使い、高さと枠だけをそろえる。
// 高さは default 32px・sm 28px（絞り込みの帯など、行に収める所）。枠は入力欄・枠のボタンと同じ border-input。
const SIZES = {
  default: "h-8 text-sm",
  sm: "h-7 text-sm",
} as const;

export type SelectSize = keyof typeof SIZES;

function Select({ size = "default", className, ...props }: { size?: SelectSize } & Omit<React.ComponentProps<"select">, "size">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "rounded-md border border-border-input bg-background px-2 text-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        SIZES[size],
        className,
      )}
      {...props}
    />
  );
}

export { Select };
