"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { errorText, postJson } from "@/lib/client/post-json";

// ログインの頁の入力（利用者名とパスワード・確認の番号・パスワードの変更）。
// 送った後は、BFF が返した次の頁（next）へ、頁ごと移る（サーバーの側で描き直すため）。

function go(next: string | undefined) {
  window.location.assign(next ?? "/");
}

function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-danger">
      {message}
    </p>
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
    setBusy(false);
    if (res.ok) go(res.data.next);
    else setError(errorText(res));
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3" aria-label="ログイン">
      <Field label="利用者名">
        <Input name="username" autoComplete="username" required />
      </Field>
      <Field label="パスワード">
        <Input name="password" type="password" autoComplete="current-password" required />
      </Field>
      <ErrorLine message={error} />
      <Button type="submit" disabled={busy}>
        ログイン
      </Button>
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
  /** いまのパスワードも求める（ログインした後の TOTP の登録の再認証） */
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
    setBusy(false);
    if (res.ok) go(res.data.next);
    // 番号の失敗・一時停止で、ログインの途中のセッションは捨てられている（BFF が next で戻り先を返す）
    else if (res.status === 401 && res.data.next) go(res.data.next);
    else setError(errorText(res));
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3" aria-label={label}>
      {askPassword && (
        <Field label="いまのパスワード">
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </Field>
      )}
      <Field label="確認の番号（認証のアプリの 6 桁）">
        <Input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 ]{6,7}"
          maxLength={7}
          required
         
        />
      </Field>
      <ErrorLine message={error} />
      <Button type="submit" disabled={busy}>
        {label}
      </Button>
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
  /** 確認の番号も求める（TOTP を登録した利用者の、ログインした後の変更の再認証） */
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
    if (form.get("newPassword") !== form.get("confirm")) {
      setError("新しいパスワードが2回で違う");
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
    setBusy(false);
    if (!res.ok) {
      setError(errorText(res));
      return;
    }
    if (askCurrent) {
      formEl.reset();
      setDone(true);
    } else {
      go(res.data.next);
    }
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="space-y-3" aria-label="パスワードの変更">
      {askCurrent && (
        <Field label="いまのパスワード">
          <Input name="currentPassword" type="password" autoComplete="current-password" required />
        </Field>
      )}
      {askCode && (
        <Field label="確認の番号（認証のアプリの 6 桁）">
          <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
        </Field>
      )}
      <Field
        label="新しいパスワード"
        hint={`${minLength} 文字以上・英字と数字を両方含める・よく使われるもの、利用者名を含むものは使えない。定期的に変える必要は無い`}
      >
        <Input name="newPassword" type="password" autoComplete="new-password" minLength={minLength} required />
      </Field>
      <Field label="新しいパスワード（もう一度）">
        <Input name="confirm" type="password" autoComplete="new-password" required />
      </Field>
      <ErrorLine message={error} />
      {done && (
        <p role="status" className="text-sm">
          パスワードを変えた
        </p>
      )}
      <Button type="submit" disabled={busy}>
        パスワードを変える
      </Button>
    </form>
  );
}
