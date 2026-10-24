"use client";

import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/pending";

// 確認の窓（docs/design-system/components.md の「確認の窓」）。HTML の dialog の showModal に任せ、
// 背景の暗幕・フォーカスの閉じ込め・Esc で閉じる動きは標準の機構のまま（自前で書かない）。
// 題は「対象＋動詞」、本文は 1〜2 文。キャンセルを左、実行を右。初期のフォーカスはキャンセル。窓の中に入力欄は置かない。

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  pending = false,
  error,
  onConfirm,
  onCancel,
  testId = "confirm-dialog",
}: {
  open: boolean;
  /** 題（対象＋動詞） */
  title: string;
  /** 本文（何が・どうなる・戻せるか。1〜2 文） */
  body: string;
  /** 実行のボタンの名前（動詞。「OK」「はい」にしない） */
  confirmLabel: string;
  /** 実行の要求を出している間 */
  pending?: boolean;
  /** 実行が通らなかったときの 1 行 */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      data-testid={testId}
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      // Esc で閉じるときも、画面の側の状態を合わせる
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      className="m-auto w-[min(440px,calc(100%-32px))] rounded-lg border border-border bg-background px-5 py-4 text-foreground shadow-lg backdrop:bg-background/60"
    >
      <h2 id={titleId} className="mb-2 text-value font-bold">
        {title}
      </h2>
      <p id={bodyId} className="text-label">
        {body}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        {/* 初期のフォーカスはキャンセル（窓の中で最初に押せるもの。誤って実行しない） */}
        <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
          キャンセル
        </Button>
        <ActionButton type="button" pending={pending} onClick={onConfirm}>
          {confirmLabel}
        </ActionButton>
      </div>
    </dialog>
  );
}
