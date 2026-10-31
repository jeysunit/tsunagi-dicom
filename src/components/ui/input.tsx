import { TriangleAlert } from "lucide-react";
import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-8 w-full rounded-md border border-border-input bg-background px-2 text-value placeholder:text-label focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 欄の下の 1 行（docs/design-system/parts.md の「入力欄」）。`.hint` は注記や読み取り結果、`.msg` は印と誤りの文。
 * 誤りがあれば `.hint` を出さず `.msg` だけを出す。欄の側は `aria-describedby` でこの id を指す（`role="alert"`・`aria-live` は付けない）
 */
function FieldNote({ hint, hintId, msg, msgId, testId }: { hint?: string; hintId?: string; msg?: string | null; msgId?: string; testId?: string }) {
  if (msg) {
    return (
      <span id={msgId} className="msg flex items-start gap-1 text-xs text-foreground" data-testid={testId && `${testId}-msg`}>
        {/* 印は i-alert（danger）、文は地の色。文が 2 行に折れても、印は 1 行目の高さに置く（部品集 1.2.5） */}
        <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0 text-danger" />
        {msg}
      </span>
    );
  }
  return hint ? (
    <span id={hintId} className="hint block text-xs text-label" data-testid={testId && `${testId}-hint`}>
      {hint}
    </span>
  ) : null;
}

/** 項目名・欄・欄の下の 1 行（注記 hint か誤り msg。hint は入力のたびに替えてよい） */
function Field({
  label,
  children,
  hint,
  hintId,
  msg,
  msgId,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  hintId?: string;
  msg?: string | null;
  msgId?: string;
  testId?: string;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-label">{label}</span>
      {children}
      <FieldNote hint={hint} hintId={hintId} msg={msg} msgId={msgId} testId={testId} />
    </label>
  );
}

export { Field, FieldNote, Input };
