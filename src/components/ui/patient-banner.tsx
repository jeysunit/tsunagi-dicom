import type * as React from "react";
import { cn } from "@/lib/utils";

// 患者バナー（docs/design-system/components.md）。患者のある画面の、見出しの下の同じ位置に同じ並びで置く。
// 並びは 氏名（かな）→ 患者 ID → 生年月日・性別 → 受付番号 → 検査日時 → モダリティ・検査の記述。値の無い項目は詰める。
// 右端（end）に状態の札と注意の枠を置く。

export interface PatientBannerItem {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}

export function PatientBanner({
  name,
  kana,
  items,
  end,
  className,
  ...props
}: {
  name: string;
  kana?: string;
  items: readonly PatientBannerItem[];
  end?: React.ReactNode;
} & Omit<React.ComponentProps<"section">, "children">) {
  return (
    <section
      aria-label="患者"
      data-slot="patient-banner"
      className={cn("flex flex-wrap items-start gap-x-6 gap-y-2 rounded-md border border-border bg-surface px-3 py-2", className)}
      {...props}
    >
      <div className="min-w-0">
        <p className="text-base font-bold break-words text-value">{name}</p>
        {kana && <p className="text-xs text-label">{kana}</p>}
      </div>
      {items
        .filter((i) => i.value !== "" && i.value != null)
        .map((i) => (
          <dl key={i.label}>
            <dt className="text-xs text-label">{i.label}</dt>
            <dd className={cn("font-bold text-value", i.mono && "font-mono font-normal")}>{i.value}</dd>
          </dl>
        ))}
      {end && <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div>}
    </section>
  );
}
