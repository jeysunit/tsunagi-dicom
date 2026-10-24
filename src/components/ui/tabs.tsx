"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// タブ（docs/design-system/components.md の「タブ・手順」）。詳細の中の切り替えだけに使う（3〜4 つまで。画面の切り替えには使わない）。
// 選んだタブは、地の色・下の線・太字で示し、aria-selected を付ける。左右の矢印のキーで移る。
// 選ばれていないタブの中身も描いておき（hidden）、中の状態（開いた画像の場所など）を切り替えても失わない。

export interface TabItem {
  id: string;
  label: string;
  content: ReactNode;
}

export function Tabs({ items, label, className }: { items: readonly TabItem[]; label: string; className?: string }) {
  const base = useId();
  const [selected, setSelected] = useState(items[0]?.id ?? "");
  const current = items.some((i) => i.id === selected) ? selected : (items[0]?.id ?? "");

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = items[(index + step + items.length) % items.length]!;
    setSelected(next.id);
    document.getElementById(`${base}-tab-${next.id}`)?.focus();
  }

  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex gap-1 border-b border-border">
        {items.map((item, index) => {
          const on = item.id === current;
          return (
            <button
              key={item.id}
              id={`${base}-tab-${item.id}`}
              type="button"
              role="tab"
              aria-selected={on}
              aria-controls={`${base}-panel-${item.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setSelected(item.id)}
              onKeyDown={(e) => onKeyDown(e, index)}
              className={cn(
                "-mb-px h-7 rounded-t-sm border-b-2 px-3 whitespace-nowrap focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                on ? "border-ring font-bold text-value" : "border-transparent text-label hover:bg-hover hover:text-value active:bg-pressed",
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => (
        <div
          key={item.id}
          id={`${base}-panel-${item.id}`}
          role="tabpanel"
          aria-labelledby={`${base}-tab-${item.id}`}
          hidden={item.id !== current}
        >
          {item.content}
        </div>
      ))}
    </div>
  );
}
