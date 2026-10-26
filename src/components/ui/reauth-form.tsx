"use client";

import { useEffect, useRef } from "react";
import { Field, Input } from "@/components/ui/input";
import { ActionButton } from "@/components/ui/pending";
import { cn } from "@/lib/utils";

// パスワードの再入力の欄（docs/design-system/parts.md の「確かめの使い分け」）。削除の確かめ・画面ロックの解除が同じ形で使う。
// 欄の名前は `password`、認証コードを求めるときは `code`。読み取りと送信は呼ぶ側の onSubmit が行う（FormData から読む）。
// 誤りは欄の下の 1 行（role="alert"）。実行のボタンは右、ほかのボタン（キャンセル・ログアウト）は左に置く。

export function ReauthForm({
  heading,
  message,
  needsCode = false,
  error,
  pending = false,
  submitLabel,
  secondary,
  visibleLabels = false,
  focusOnMount = false,
  alignEnd = false,
  onSubmit,
  className,
  ariaLabel,
  testId,
}: {
  /** 見出し（呼ぶ側の要素。aria-labelledby の相手は呼ぶ側が決める） */
  heading?: React.ReactNode;
  /** 何のために再入力するか（1 文） */
  message?: React.ReactNode;
  /** 認証コード（TOTP）の欄を足す */
  needsCode?: boolean;
  error?: string | null;
  /** 認証の要求を出している間 */
  pending?: boolean;
  /** 実行のボタンの名前 */
  submitLabel: string;
  /** 実行のボタンの左に置くボタン（キャンセル・ログアウト） */
  secondary?: React.ReactNode;
  /** 欄の名前を目に見える文字で出す（false なら aria-label だけ） */
  visibleLabels?: boolean;
  /** 出たらパスワードの欄へフォーカスを移す */
  focusOnMount?: boolean;
  /** ボタンを右端に寄せる */
  alignEnd?: boolean;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
  className?: string;
  ariaLabel?: string;
  testId?: string;
}) {
  const passwordRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusOnMount) passwordRef.current?.focus();
  }, [focusOnMount]);

  return (
    <form onSubmit={onSubmit} aria-label={ariaLabel} className={cn("space-y-2", className)} data-testid={testId}>
      {heading}
      {message && <p className="text-label">{message}</p>}
      {visibleLabels ? (
        <Field label="パスワード">
          <Input ref={passwordRef} name="password" type="password" autoComplete="current-password" required />
        </Field>
      ) : (
        <Input ref={passwordRef} name="password" type="password" autoComplete="current-password" aria-label="パスワード" required />
      )}
      {needsCode && (
        <Field label="認証コード（6 桁）">
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
        </Field>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className={cn("flex gap-2", alignEnd && "justify-end")}>
        {secondary}
        <ActionButton type="submit" size={visibleLabels ? "default" : "sm"} pending={pending}>
          {submitLabel}
        </ActionButton>
      </div>
    </form>
  );
}
