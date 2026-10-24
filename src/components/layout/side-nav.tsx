"use client";

import { Eye, Inbox, List, Network, UserCog, Users, type LucideIcon } from "lucide-react";
import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import { isCurrent, type NavGroup, type NavIcon } from "@/components/layout/nav-items";
import { Spinner, useDelayedPending } from "@/components/ui/pending";
import { cn } from "@/lib/utils";

const ICONS: Record<NavIcon, LucideIcon> = {
  studies: List,
  received: Inbox,
  modalities: Network,
  viewers: Eye,
  users: Users,
  account: UserCog,
};

/** 押した頁の項目の、頁の切り替えの待ちの印（0.3 秒たっても移らなければ出す。docs/spec.md の 2.3） */
function LinkPending() {
  const { pending } = useLinkStatus();
  const shown = useDelayedPending(pending);
  return shown ? <Spinner className="ml-auto inline size-3.5 shrink-0 group-data-[nav=collapsed]/body:hidden" /> : null;
}

// 左のナビ（docs/design-system/menu.md・docs/spec.md の 2.3）。幅 208px（閉じると 56px。閉じる・開くは上の帯のボタン）。
// 今いる頁の項目は、選んだ行の地・左の線・太字で示し、aria-current="page" を付ける。色だけで示さない。
// 出す項目は、役割に許された頁だけ（`buildNavGroups` が決める）。閉じている間は、項目名を読み上げ用にだけ残し、title に出す。
export function SideNav({ groups }: { groups: readonly NavGroup[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label="ページ"
      data-testid="site-nav"
      className="w-52 shrink-0 border-r border-border bg-surface px-2 py-3 group-data-[nav=collapsed]/body:w-14"
    >
      {groups.map((group) => (
        <div key={group.label} className="mb-3 last:mb-0">
          <p className="mb-1 px-2 text-xs text-label group-data-[nav=collapsed]/body:sr-only">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const current = isCurrent(pathname, item.href);
              const Icon = ICONS[item.icon];
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    title={item.label}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2 rounded-sm border-l-[3px] px-2 whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                      current
                        ? "border-ring bg-selected font-bold text-value"
                        : "border-transparent text-foreground hover:bg-hover hover:text-value active:bg-pressed",
                    )}
                  >
                    <Icon aria-hidden className="size-4 shrink-0" />
                    <span className="group-data-[nav=collapsed]/body:sr-only">{item.label}</span>
                    <LinkPending />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
