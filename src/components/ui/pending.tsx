"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// 待ちの表示の部品（docs/spec.md の 2.3）。どの画面もこの1つを使う。
// 操作から 0.3 秒たっても終わらなければ印を出し、一度出した印は 0.5 秒は消さない（すぐ終わる操作でちらつかないように）。
// 印は押したボタンの中か、一覧の上の細い帯に出す。画面全体を覆う幕にはしない。

/** 印を出すまでの待ち（ミリ秒） */
export const PENDING_DELAY_MS = 300;
/** 一度出した印を出しておく最短の時間（ミリ秒） */
export const PENDING_MIN_MS = 500;

/** 待っている（pending）のうち、印を出すべき間だけ true を返す */
export function useDelayedPending(pending: boolean, delay = PENDING_DELAY_MS, min = PENDING_MIN_MS): boolean {
  const [shown, setShown] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    if (pending && !shown) {
      const t = window.setTimeout(() => {
        shownAt.current = Date.now();
        setShown(true);
      }, delay);
      return () => window.clearTimeout(t);
    }
    if (!pending && shown) {
      const left = Math.max(0, min - (Date.now() - shownAt.current));
      const t = window.setTimeout(() => setShown(false), left);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [pending, shown, delay, min]);
  return shown;
}

/** 回る印。読み上げには、横に添える文字（「読み込み中」など）か、ボタンの aria-busy で知らせる */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden data-testid="spinner" className={cn("size-4 shrink-0 animate-spin", className)} />;
}

/** 一覧の上の細い進みの帯（2px）。画面を覆わない */
export function ProgressBar({ label = "読み込み中" }: { label?: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-busy="true" className="relative h-0.5 w-full overflow-hidden bg-hover" data-testid="progress-bar">
      <div className="absolute inset-y-0 left-0 w-1/3 animate-[tsunagi-progress_1.2s_ease-in-out_infinite] bg-primary" />
    </div>
  );
}

/**
 * 操作を始めるボタン（送信・接続確認・ログイン・ロック解除・保存・削除）。pending の間はすぐ押せなくし（二度押しを止める）、
 * 0.3 秒たっても終わらなければ、アイコンを回る印に替える（ボタンの幅は変えない。アイコンの無いボタンは印を足す）
 */
export function ActionButton({
  pending = false,
  icon,
  children,
  disabled,
  ...props
}: React.ComponentProps<typeof Button> & { pending?: boolean; icon?: React.ReactNode }) {
  const shown = useDelayedPending(pending);
  return (
    <Button {...props} disabled={disabled || pending} aria-busy={pending || undefined} data-pending={shown || undefined}>
      {shown ? <Spinner /> : icon}
      {children}
    </Button>
  );
}

/** 文字つきの待ちの印（「読み込み中」）。delay の間は何も出さない */
export function PendingText({ pending, children = "読み込み中" }: { pending: boolean; children?: React.ReactNode }) {
  const shown = useDelayedPending(pending);
  if (!shown) return null;
  return (
    <span role="status" className="inline-flex items-center gap-1.5 text-xs text-label" data-testid="pending-text">
      <Spinner />
      {children}
    </span>
  );
}
