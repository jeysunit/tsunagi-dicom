"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROLE_LABELS, ROLES, isRole } from "@/lib/auth/roles";
import { errorText, postJson, type PostResult } from "@/lib/client/post-json";

export interface UserRowView {
  id: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  totpEnabled: boolean;
  lastLogin: string | null;
  lastLoginDaysAgo: number | null;
  created: string;
  lockedUntil: string | null;
}

// 利用者の一覧（棚卸し）と、作る・役割を変える・止める／戻す・TOTP のやり直し・一時停止の解除。
// これらは大事な操作なので、直前の本人の確かめ（再認証）が要る。BFF が求めたら、パスワードと確認の番号を入れてもらい、
// 通ったら同じ操作をもう一度送る。
export function UserAdmin({
  users,
  csrfToken,
  selfId,
  minPasswordLength,
  needsTotp,
}: {
  users: UserRowView[];
  csrfToken: string;
  selfId: string;
  minPasswordLength: number;
  needsTotp: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reauth, setReauth] = useState<{ retry: () => Promise<PostResult> ; done: (res: PostResult) => void } | null>(
    null,
  );
  const [reauthError, setReauthError] = useState<string | null>(null);

  /** 送って、再認証を求められたら、その画面を出して待つ */
  async function send(run: () => Promise<PostResult>, done: (res: PostResult) => void) {
    const res = await run();
    if (res.status === 403 && res.data.problems?.includes("reauth_required")) {
      setReauthError(null);
      setReauth({ retry: run, done });
      return;
    }
    done(res);
  }

  async function onReauth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reauth) return;
    const form = new FormData(event.currentTarget);
    const res = await postJson(
      "/api/auth/reauth",
      { password: form.get("password"), ...(needsTotp ? { code: form.get("code") } : {}) },
      csrfToken,
    );
    if (res.data.next) {
      window.location.assign(res.data.next);
      return;
    }
    if (!res.ok) {
      setReauthError(errorText(res));
      return;
    }
    const pendingAction = reauth;
    setReauth(null);
    pendingAction.done(await pendingAction.retry());
  }

  async function change(id: string, body: Record<string, unknown>, done: string) {
    setMessage(null);
    await send(
      () => postJson(`/api/admin/users/${encodeURIComponent(id)}`, body, csrfToken, "PATCH"),
      (res) => afterChange(res, done),
    );
  }

  function afterChange(res: PostResult, done: string) {
    if (!res.ok) {
      setMessage({ ok: false, text: errorText(res) });
      return;
    }
    setMessage({ ok: true, text: done });
    startTransition(() => router.refresh());
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formEl = event.currentTarget;
    const form = new FormData(formEl);
    setMessage(null);
    const body = {
      username: form.get("username"),
      displayName: form.get("displayName"),
      role: form.get("role"),
      password: form.get("password"),
    };
    await send(
      () => postJson("/api/admin/users", body, csrfToken),
      (res) => {
        if (!res.ok) {
          setMessage({ ok: false, text: errorText(res) });
          return;
        }
        formEl.reset();
        setMessage({ ok: true, text: "利用者を作った。最初のログインで本人がパスワードを変える" });
        startTransition(() => router.refresh());
      },
    );
  }

  return (
    <section className="space-y-6">
      <h1 className="text-lg font-bold text-value">利用者</h1>
      {reauth && (
        <form
          onSubmit={(e) => void onReauth(e)}
          aria-label="本人の確かめ"
          className="max-w-sm space-y-3 rounded-md border border-border bg-surface p-3"
        >
          <p className="text-label">利用者の管理は大事な操作なので、パスワード{needsTotp ? "と確認の番号" : ""}をもう一度入れる。</p>
          <Field label="パスワード">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          {needsTotp && (
            <Field label="確認の番号（認証のアプリの 6 桁）">
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
            </Field>
          )}
          {reauthError && (
            <p role="alert" className="text-sm text-red-300">
              {reauthError}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit">確かめて続ける</Button>
            <Button type="button" variant="outline" onClick={() => setReauth(null)}>
              やめる
            </Button>
          </div>
        </form>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm" : "text-sm text-red-300"}>
          {message.text}
        </p>
      )}

      <Table data-testid="user-table">
        <TableCaption>利用者 {users.length} 人。最後のログインが古い利用者・要らない利用者は止める</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>利用者名</TableHead>
            <TableHead>表示の名前</TableHead>
            <TableHead>役割</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>TOTP</TableHead>
            <TableHead>最後のログイン</TableHead>
            <TableHead>作った日</TableHead>
            <TableHead>操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            <TableRow key={u.id} data-username={u.username}>
              <TableCell className="font-mono">{u.username}</TableCell>
              <TableCell className="font-bold text-value">{u.displayName}</TableCell>
              <TableCell>
                <select
                  aria-label={`${u.username} の役割`}
                  value={u.role}
                  disabled={pending}
                  onChange={(e) => {
                    const role = e.target.value;
                    if (isRole(role)) void change(u.id, { role }, `${u.username} の役割を${ROLE_LABELS[role]}にした`);
                  }}
                  className="h-7 rounded-md border border-border bg-background px-1"
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </TableCell>
              <TableCell>
                {u.status === "active" ? "有効" : "止めている"}
                {u.lockedUntil && <span className="block text-xs text-label">一時停止（{u.lockedUntil} まで）</span>}
              </TableCell>
              <TableCell>{u.totpEnabled ? "登録あり" : "未登録"}</TableCell>
              <TableCell data-testid="last-login">
                {u.lastLogin ?? "まだ無い"}
                {u.lastLoginDaysAgo !== null && u.lastLoginDaysAgo >= 90 && (
                  <span className="block text-xs text-label">{u.lastLoginDaysAgo} 日前</span>
                )}
              </TableCell>
              <TableCell>{u.created}</TableCell>
              <TableCell className="space-x-1 whitespace-nowrap">
                {u.id !== selfId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void change(
                        u.id,
                        { status: u.status === "active" ? "disabled" : "active" },
                        u.status === "active" ? `${u.username} を止めた` : `${u.username} を戻した`,
                      )
                    }
                  >
                    {u.status === "active" ? "止める" : "戻す"}
                  </Button>
                )}
                {u.totpEnabled && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void change(u.id, { resetTotp: true }, `${u.username} の TOTP をやり直す（次のログインで登録）`)}
                  >
                    TOTP をやり直す
                  </Button>
                )}
                {u.lockedUntil && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void change(u.id, { clearLoginLock: true }, `${u.username} の一時停止を解いた`)}
                  >
                    一時停止を解く
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <form onSubmit={(e) => void create(e)} className="max-w-sm space-y-3" aria-label="利用者を作る">
        <h2 className="font-bold text-value">利用者を作る</h2>
        <Field label="利用者名" hint="英小文字・数字で始め、英小文字・数字・. _ - の 3〜64 文字。後から変えられない">
          <Input name="username" required autoComplete="off" />
        </Field>
        <Field label="表示の名前">
          <Input name="displayName" required autoComplete="off" />
        </Field>
        <Field label="役割">
          <select name="role" defaultValue="viewer" className="h-8 w-full rounded-md border border-border bg-background px-2">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="最初のパスワード"
          hint={`${minPasswordLength} 文字以上・英字と数字を両方含める。本人は最初のログインで変える`}
        >
          <Input name="password" type="password" required autoComplete="new-password" minLength={minPasswordLength} />
        </Field>
        <Button type="submit" disabled={pending}>
          作る
        </Button>
      </form>
    </section>
  );
}
