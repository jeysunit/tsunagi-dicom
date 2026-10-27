"use client";

import { useState } from "react";
import { Field, Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { ActionButton } from "@/components/ui/pending";
import { errorText, postJson } from "@/lib/client/post-json";

// ログインの頁の入力（ユーザーID とパスワード・認証コード・パスワードの変更）。
// 送った後は、BFF が返した次の頁（next）へ、頁ごと移る（サーバーの側で描き直すため）。
// 画面の言葉は docs/spec.md の 2.2 の用語集から選ぶ。

function go(next: string | undefined) {
  window.location.assign(next ?? "/");
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <Notice kind="err" alert>
      {message}
    </Notice>
  ) : null;
}

export function LoginForm() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await postJson("/api/auth/login", { username: form.get("username"), password: form.get("password") });
    if (res.ok) {
      // 頁ごと移る間も、押したボタンの印を出し続ける（移るまでが待ち）
      go(res.data.next);
      return;
    }
    setBusy(false);
    setError(errorText(res));
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3" aria-label="ログイン">
      <Field label="ユーザーID">
        <Input name="username" autoComplete="username" required />
      </Field>
      <Field label="パスワード">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <ErrorLine message={error} />
      <ActionButton type="submit" pending={busy}>
        ログイン
      </ActionButton>
    </form>
  );
}

export function CodeForm({
  endpoint,
  csrfToken,
  label,
  askPassword = false,
}: {
  endpoint: string;
  csrfToken: string;
  label: string;
  /** 現在のパスワードも求める（ログインした後の二要素認証の設定の再認証） */
  askPassword?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await postJson(
      endpoint,
      { code: form.get("code"), ...(askPassword ? { currentPassword: form.get("currentPassword") } : {}) },
      csrfToken,
    );
    if (res.ok) {
      go(res.data.next);
      return;
    }
    // コードの失敗・ロック中で、ログインの途中のセッションは捨てられている（BFF が next で戻り先を返す）
    if (res.status === 401 && res.data.next) {
      go(res.data.next);
      return;
    }
    setBusy(false);
    setError(errorText(res));
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3" aria-label={label}>
      {askPassword && (
        <Field label="現在のパスワード">
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </Field>
      )}
      <Field label="認証コード（6 桁）">
        <Input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
      </Field>
      <ErrorLine message={error} />
      <ActionButton type="submit" pending={busy}>
        {label}
      </ActionButton>
    </form>
  );
}

export function PasswordForm({
  csrfToken,
  askCurrent,
  askCode = false,
  minLength,
}: {
  csrfToken: string;
  askCurrent: boolean;
  /** 認証コードも求める（二要素認証を設定した利用者の、ログインした後の変更） */
  askCode?: boolean;
  minLength: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setDone(false);
    if (form.get("newPassword") !== form.get("confirm")) {
      setError("確認用のパスワードが一致しません");
      return;
    }
    setBusy(true);
    setError(null);
    const res = await postJson(
      "/api/auth/password",
      {
        ...(askCurrent ? { currentPassword: form.get("currentPassword") } : {}),
        ...(askCode ? { code: form.get("code") } : {}),
        newPassword: form.get("newPassword"),
      },
      csrfToken,
    );
    if (!res.ok) {
      setBusy(false);
      setError(errorText(res));
      return;
    }
    if (askCurrent) {
      setBusy(false);
      formEl.reset();
      setDone(true);
    } else {
      go(res.data.next);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3" aria-label="パスワードの変更">
      {askCurrent && (
        <Field label="現在のパスワード">
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </Field>
      )}
      {askCode && (
        <Field label="認証コード（6 桁）">
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
        </Field>
      )}
      <Field label="新しいパスワード" hint={`${minLength} 文字以上・英字と数字を含む（よく使われるもの・ユーザーIDを含むものは不可）`}>
        <Input name="newPassword" type="password" autoComplete="new-password" minLength={minLength} required />
      </Field>
      <Field label="新しいパスワード（確認）">
        <Input name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <ErrorLine message={error} />
      {done && <Notice kind="ok">パスワードを変更しました</Notice>}
      <ActionButton type="submit" pending={busy}>
        変更
      </ActionButton>
    </form>
  );
}
