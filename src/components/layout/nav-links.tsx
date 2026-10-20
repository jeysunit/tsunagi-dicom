"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { Spinner, useDelayedPending } from "@/components/ui/pending";
import { cn } from "@/lib/utils";

/** 押した頁の項目の、頁の切り替えの待ちの印（0.3 秒たっても移らなければ出す。docs/spec.md の 2.3） */
function LinkPending() {
  const { pending } = useLinkStatus();
  const shown = useDelayedPending(pending);
  return shown ? <Spinner className="ml-1.5 inline size-3.5 align-[-2px]" /> : null;
}

// 見出しの頁の道（docs/spec.md の 2.3）。今いる頁の項目は、タブの形（地の色と下の線・太字）で示し、aria-current="page" を付ける。
// 色だけで示さない（下の線と太字も付ける）。出す項目は、役割に許された頁だけ（見出しの側で決めて渡す）。

export interface NavItem {
  href: string;
  label: string;
}

/** 今いる頁か。検査の一覧（/）は完全に一致したときだけ、ほかは頁の下の道（/admin/users/… など）も含める */
export function isCurrent(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function NavLinks({ items }: { items: readonly NavItem[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="頁" className="flex items-end gap-1 self-stretch" data-testid="site-nav">
      {items.map((item) => {
        const current = isCurrent(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "-mb-2.5 rounded-t-md border-b-2 px-3 pt-1.5 pb-2 whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              current
                ? "border-primary bg-background font-bold text-value"
                : "border-transparent text-label hover:bg-hover hover:text-value active:bg-pressed",
            )}
          >
            {item.label}
            <LinkPending />
          </Link>
        );
      })}
    </nav>
  );
}
