import type * as React from "react";
import { cn } from "@/lib/utils";

// 患者バナー（docs/design-system/components.md）。患者のある画面の、見出しの下の同じ位置に同じ並びで置く。
// 並びは 氏名（かな）→ 患者ID → 生年月日・性別 → 受付番号 → 検査日時 → モダリティ・検査名。値の無い項目は詰める。
// 右端（end）に状態の札と注意の枠を置く。和暦・紹介医・Study ID などの毎回は見ない値は、バナーに足さず「検査の情報」に置く。

export interface PatientBannerItem {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  /** 試験で項目を見つけるための印 */
  testId?: string;
}

export function PatientBanner({
  name,
  kana,
  items,
  end,
  nameTestId,
  className,
  ...props
}: {
  name: React.ReactNode;
  kana?: string;
  items: readonly PatientBannerItem[];
  end?: React.ReactNode;
  nameTestId?: string;
} & Omit<React.ComponentProps<"section">, "children">) {
  return (
    <section
      aria-label="患者"
      data-slot="patient-banner"
      className={cn("flex flex-wrap items-start gap-x-6 gap-y-2 rounded-md border border-border bg-surface px-3 py-1.5", className)}
      {...props}
    >
      <div className="min-w-0">
        <p className="text-base font-bold break-words text-value" data-testid={nameTestId}>
          {name}
        </p>
        {kana && <p className="text-xs text-label">{kana}</p>}
      </div>
      {items
        .filter((i) => i.value !== "" && i.value != null)
        .map((i) => (
          <dl key={i.label} className="min-w-0" data-testid={i.testId}>
            <dt className="text-xs text-label">{i.label}</dt>
            <dd className={cn("font-bold break-words text-value", i.mono && "font-mono font-normal")}>{i.value}</dd>
          </dl>
        ))}
      {end && <div className="ml-auto flex flex-wrap items-center gap-2">{end}</div>}
    </section>
  );
}
