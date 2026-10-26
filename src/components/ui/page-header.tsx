import type * as React from "react";
import { cn } from "@/lib/utils";

// 見出しの行（docs/design-system/parts.md の「見出しの行・パンくず」）。h1 は 20px・行 28px・太字で、中身は頁の名前だけ。
// 日付や件数は h1 に入れず、補足（small）か件数の行に置く。右の actions にその画面の操作（主は右端に 1 つ）。
export function PageHeader({
  title,
  note,
  actions,
  className,
  ...props
}: {
  title: string;
  /** 補足（14px・label）。h1 の中の small になる */
  note?: string;
  /** 画面の操作 */
  actions?: React.ReactNode;
} & Omit<React.ComponentProps<"div">, "title">) {
  return (
    <div data-slot="page-header" className={cn("flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2", className)} {...props}>
      <h1 className="text-xl leading-7 font-bold text-value">
        {title}
        {note && <small className="ml-3 text-sm font-normal text-label">{note}</small>}
      </h1>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
