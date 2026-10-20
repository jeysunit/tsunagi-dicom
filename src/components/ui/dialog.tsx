"use client";

import { useEffect, useRef } from "react";
import type * as React from "react";
import { cn } from "@/lib/utils";

/**
 * 頁の上に重ねる確かめの画面（ブラウザの dialog 要素を showModal で開く）。開いている間は後ろの頁を押せず、
 * Tab は画面の中だけを回り、Escape で閉じる（onClose）。開いたら、data-autofocus を付けた部品（無ければ最初の部品）へ
 * フォーカスを移し、閉じたら開く前の部品へ戻す（ブラウザの決まり）。UX のレビューの M7（確かめと再認証を、押した所から
 * 離れた頁の上に出さず、フォーカスを移す）。
 */
export function Dialog({
  open,
  label,
  onClose,
  className,
  children,
}: {
  open: boolean;
  /** 読み上げの名前 */
  label: string;
  onClose: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // 初めのフォーカスは data-autofocus を付けた部品（無ければブラウザの決まりで最初の部品）
      d.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-label={label}
      onCancel={(e) => {
        // Escape：ブラウザに閉じさせず、持ち主の状態から閉じる（状態と見た目をずらさない）
        e.preventDefault();
        onClose();
      }}
      className={cn(
        "m-auto w-full max-w-sm rounded-md border border-border bg-background p-4 text-foreground shadow-lg backdrop:bg-black/40",
        className,
      )}
    >
      {open && children}
    </dialog>
  );
}
