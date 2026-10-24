import type * as React from "react";
import { cn } from "@/lib/utils";

// 件数の行（docs/design-system/components.md）。一覧の上、検索の帯の下に 1 行。左に件数、右に補足（自動更新の状態など）。
// 高さ 28px 以上を常に確保し、検索の欄が空かどうか・補足の有無で件数の位置を動かさない。
export function CountRow({ aside, className, children, ...props }: { aside?: React.ReactNode } & React.ComponentProps<"div">) {
  return (
    <div data-slot="count-row" className={cn("flex min-h-7 flex-wrap items-baseline justify-between gap-x-4 gap-y-1", className)} {...props}>
      <div className="flex flex-wrap items-baseline gap-2">{children}</div>
      {aside && <div className="flex flex-wrap items-baseline gap-2 text-xs text-label">{aside}</div>}
    </div>
  );
}
