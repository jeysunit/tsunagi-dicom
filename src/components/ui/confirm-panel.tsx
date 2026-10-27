"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/pending";
import { cn } from "@/lib/utils";

// 確かめの欄（docs/design-system/parts.md の「確かめの使い分け」）。理由や再認証を書かせる確かめを、区画の中の欄で出す。
// 並びは 対象の要約（患者バナーの縮めた形：氏名・患者ID・生年月日と性別）→ 対象の詳細 → 戻せるか → 入力欄・状態 → 操作の行。
// 操作の行は、キャンセルを左、実行を右（確認の窓と同じ向き）。
// 開いたらその欄が見えるまでスクロールし、最初の入力へフォーカスを移す（入力欄が遅れて出るときは focusReady で待つ）。

export interface ConfirmSummary {
  name: string;
  patientId: string;
  /** 生年月日と性別を 1 つにした文字列（例：1975/05/10（昭和50年・51歳・男））。無ければ「—」 */
  birthLine: string;
}

export function ConfirmPanel({
  id,
  label,
  tone = "default",
  testId,
  confirmTestId,
  summary,
  details,
  reversible,
  focusReady = true,
  children,
}: {
  id?: string;
  /** 欄の名前（読み上げ） */
  label: string;
  /** 取り消せない操作は danger（枠が danger の色） */
  tone?: "default" | "danger";
  testId?: string;
  /** 対象の要約・詳細・戻せるかを包む要素の印（試験で中身を見つけるため） */
  confirmTestId?: string;
  summary?: ConfirmSummary;
  /** 対象の詳細（項目名と値の対。呼ぶ側が dl で組む） */
  details?: React.ReactNode;
  /** 戻せるか。取り消せない操作は、その旨を最初の行に */
  reversible?: React.ReactNode;
  /** 最初の入力が描かれたら true。それまではフォーカスを移さない */
  focusReady?: boolean;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const focused = useRef(false);

  // 開いたら、その欄が見えるまでスクロールする（欄は開いたときに作られる）
  useEffect(() => {
    if (scrolled.current) return;
    scrolled.current = true;
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []);

  // 最初の入力へフォーカスを移す。利用者がすでに欄の中へ移していれば奪わない
  useEffect(() => {
    if (!focusReady || focused.current) return;
    focused.current = true;
    const el = ref.current;
    if (!el || el.contains(document.activeElement)) return;
    el.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])")?.focus();
  }, [focusReady]);

  return (
    <div
      ref={ref}
      id={id}
      role="group"
      aria-label={label}
      className={cn("mt-2 space-y-2 rounded-md border bg-surface p-3", tone === "danger" ? "border-danger" : "border-border")}
      data-testid={testId}
    >
      {(summary || details || reversible) && (
        <div className="space-y-1 text-sm" data-testid={confirmTestId}>
          {summary && <ConfirmSummaryRow summary={summary} />}
          {details}
          {reversible}
        </div>
      )}
      {children}
    </div>
  );
}

/** 対象の要約：氏名・患者ID・生年月日と性別の 3 つだけ（ほかの升を足さない）。無い値は「—」 */
function ConfirmSummaryRow({ summary }: { summary: ConfirmSummary }) {
  const items = [
    { label: "氏名", value: summary.name, testId: "confirm-name" },
    { label: "患者ID", value: summary.patientId, testId: "confirm-patient-id" },
    { label: "生年月日・性別", value: summary.birthLine, testId: "confirm-birth" },
  ];
  return (
    <dl aria-label="対象の患者" className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-border bg-background px-3 py-1.5" data-testid="confirm-summary">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs text-label">{i.label}</dt>
          <dd className={cn("font-bold break-words", i.value ? "text-value" : "text-label")} data-testid={i.testId}>
            {i.value || "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 操作の行：キャンセルを左、実行を右。実行を外す（hideConfirm）と、キャンセル（閉じる）だけになる */
export function ConfirmActions({
  confirmLabel,
  confirmTestId,
  confirmVariant = "default",
  confirmIcon,
  confirmDisabled = false,
  pending = false,
  onConfirm,
  hideConfirm = false,
  cancelLabel = "キャンセル",
  cancelTestId,
  cancelDisabled = false,
  onCancel,
  extra,
  note,
}: {
  confirmLabel: string;
  confirmTestId?: string;
  confirmVariant?: "default" | "danger";
  confirmIcon?: React.ReactNode;
  confirmDisabled?: boolean;
  /** 実行の要求を出している間 */
  pending?: boolean;
  /** 渡すと type="button" の実行。渡さなければ type="submit"（form の中で使う） */
  onConfirm?: () => void;
  hideConfirm?: boolean;
  cancelLabel?: string;
  cancelTestId?: string;
  cancelDisabled?: boolean;
  onCancel: () => void;
  /** キャンセルと実行の間に置くボタン（再送信など） */
  extra?: React.ReactNode;
  /** 操作の行の右に添える 1 行 */
  note?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={cancelDisabled} onClick={onCancel} data-testid={cancelTestId}>
        {cancelLabel}
      </Button>
      {extra}
      {!hideConfirm && (
        <ActionButton
          type={onConfirm ? "button" : "submit"}
          size="sm"
          variant={confirmVariant}
          pending={pending}
          disabled={confirmDisabled}
          icon={confirmIcon}
          data-testid={confirmTestId}
          onClick={onConfirm}
        >
          {confirmLabel}
        </ActionButton>
      )}
      {note}
    </div>
  );
}
