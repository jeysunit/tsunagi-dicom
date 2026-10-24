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

/**
 * 項目の絵。押した頁の切り替えを待っている間（0.3 秒たっても移らなければ。docs/spec.md の 2.3）は、絵の場所に待ちの印を出す。
 * 閉じた状態（幅 56px）でも見えるよう、項目名の横ではなく絵の場所に出す
 */
function ItemIcon({ icon: Icon }: { icon: LucideIcon }) {
  const { pending } = useLinkStatus();
  const shown = useDelayedPending(pending);
  return shown ? <Spinner className="size-4 shrink-0" /> : <Icon aria-hidden className="size-4 shrink-0" />;
}

// 左のナビ（docs/design-system/menu.md・docs/spec.md の 2.3）。幅 208px（閉じると 56px。閉じる・開くは上の帯のボタン）。
// 今いる頁の項目は、選んだ行の地・左の線・太字で示し、aria-current="page" を付ける。色だけで示さない。
// 出す項目は、役割に許された頁だけ（`buildNavGroups` が決める）。閉じている間は、項目名を読み上げ用にだけ残し、title に出す。
// 項目が画面の高さを超えるとき（低い画面・拡大表示）は、ナビの中でスクロールする。
export function SideNav({ groups }: { groups: readonly NavGroup[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label="ページ"
      data-testid="site-nav"
      className="min-h-0 w-52 shrink-0 overflow-y-auto border-r border-border bg-surface px-2 py-3 group-data-[nav=collapsed]/body:w-14"
    >
      {groups.map((group) => (
        <div key={group.label} className="mb-3 last:mb-0">
          <p className="mb-1 px-2 text-xs text-label group-data-[nav=collapsed]/body:sr-only">{group.label}</p>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item) => {
              const current = isCurrent(pathname, item.href);
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
                    <ItemIcon icon={ICONS[item.icon]} />
                    <span className="group-data-[nav=collapsed]/body:sr-only">{item.label}</span>
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
