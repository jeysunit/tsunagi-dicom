"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { ActionButton } from "@/components/ui/pending";
import { CellMain, CellSub, Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

// 利用者の一覧（棚卸し）と、作る・役割を変える・止める／戻す・TOTP のやり直し・一時停止の解除。画面の言葉は docs/spec.md の 2.2。
// これらは大事な操作なので、直前の本人の確かめ（再認証）が要る。BFF が求めたら、パスワードと（TOTP を登録していれば）
// 認証コードを入れてもらい、通ったら同じ操作をもう一度送る。削除の再認証はパスワードだけだが、利用者の管理は TOTP まで求める
// （パスワードとセッションだけで管理者を作り足させない。docs/spec.md の 3.6）。
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
  /** 再認証で認証コードも求めるか（TOTP を登録した管理者） */
  needsTotp: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [reauth, setReauth] = useState<{ retry: () => Promise<PostResult> ; done: (res: PostResult) => void } | null>(
    null,
  );
  const [reauthError, setReauthError] = useState<string | null>(null);
  /** 再認証・ユーザーの追加の要求を送っている間（押したボタンに待ちの印を出す） */
  const [authing, setAuthing] = useState(false);
  const [creating, setCreating] = useState(false);

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
    setAuthing(true);
    const res = await postJson(
      "/api/auth/reauth",
      { password: form.get("password"), ...(needsTotp ? { code: form.get("code") } : {}) },
      csrfToken,
    );
    setAuthing(false);
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
    setCreating(true);
    await send(
      () => postJson("/api/admin/users", body, csrfToken),
      (res) => {
        if (!res.ok) {
          setMessage({ ok: false, text: errorText(res) });
          return;
        }
        formEl.reset();
        setMessage({ ok: true, text: "ユーザーを追加しました。初回ログイン時にパスワードの変更を求めます" });
        startTransition(() => router.refresh());
      },
    );
    // 再認証を求められたときも、ここで印を外す（再認証の画面の「認証して続行」に印が移る）
    setCreating(false);
  }

  return (
    <section className="space-y-6">
      <h1 className="text-lg font-bold text-value">ユーザー管理</h1>
      {reauth && (
        <form
          onSubmit={(e) => void onReauth(e)}
          aria-label="再認証"
          className="max-w-sm space-y-3 rounded-md border border-border bg-surface p-3"
        >
          <p className="text-label">{needsTotp ? "この操作にはパスワードと認証コードの再入力が必要です" : "この操作にはパスワードの再入力が必要です"}</p>
          <Field label="パスワード">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>
          {needsTotp && (
            <Field label="認証コード（6 桁）">
              <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
            </Field>
          )}
          {reauthError && (
            <p role="alert" className="text-sm text-danger">
              {reauthError}
            </p>
          )}
          <div className="flex gap-2">
            <ActionButton type="submit" pending={authing}>
              認証して続行
            </ActionButton>
            <Button type="button" variant="outline" disabled={authing} onClick={() => setReauth(null)}>
              キャンセル
            </Button>
          </div>
        </form>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm" : "text-sm text-danger"}>
          {message.text}
        </p>
      )}

      <Table data-testid="user-table">
        <TableCaption>{users.length} 件</TableCaption>
        <TableHeader>
          <tr className="h-7">
            <TableHead>ユーザーID</TableHead>
            <TableHead>表示名</TableHead>
            <TableHead>役割</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>二要素認証</TableHead>
            <TableHead>最終ログイン</TableHead>
            <TableHead>作成日</TableHead>
            <TableHead>操作</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {users.map((u) => (
            // 行の中に選択欄とボタン、補足の 2 行目があるので 40px の行（docs/design-system/parts.md の「一覧の表」）
            <TableRow key={u.id} data-username={u.username} tall>
              <TableCell className="font-mono whitespace-nowrap">{u.username}</TableCell>
              <TableCell>
                <CellMain>{u.displayName}</CellMain>
              </TableCell>
              <TableCell>
                <select
                  aria-label={`${u.username} の役割`}
                  value={u.role}
                  disabled={pending}
                  onChange={(e) => {
                    const role = e.target.value;
                    if (isRole(role)) void change(u.id, { role }, `${u.username} の役割を「${ROLE_LABELS[role]}」に変更しました`);
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
                {u.status === "active" ? "有効" : "無効"}
                {u.lockedUntil && <CellSub>ロック中（{u.lockedUntil} まで）</CellSub>}
              </TableCell>
              <TableCell>{u.totpEnabled ? "設定済み" : "未設定"}</TableCell>
              <TableCell data-testid="last-login">
                {u.lastLogin ?? "—"}
                {u.lastLoginDaysAgo !== null && u.lastLoginDaysAgo >= 90 && (
                  <CellSub>{u.lastLoginDaysAgo} 日前</CellSub>
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
                        u.status === "active" ? `${u.username} を無効にしました` : `${u.username} を有効にしました`,
                      )
                    }
                  >
                    {u.status === "active" ? "無効にする" : "有効にする"}
                  </Button>
                )}
                {/* 自分の二要素認証のリセットは出さない（BFF も断る。別の管理者が行う。docs/spec.md の 3.6） */}
                {u.totpEnabled && u.id !== selfId && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void change(u.id, { resetTotp: true }, `${u.username} の二要素認証をリセットしました（次回ログイン時に再設定）`)}
                  >
                    二要素認証をリセット
                  </Button>
                )}
                {u.lockedUntil && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => void change(u.id, { clearLoginLock: true }, `${u.username} のロックを解除しました`)}
                  >
                    ロック解除
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <form onSubmit={(e) => void create(e)} className="max-w-sm space-y-3" aria-label="ユーザーの追加">
        <h2 className="font-bold text-value">ユーザーの追加</h2>
        <Field label="ユーザーID" hint="英小文字・数字・. _ -（3〜64 文字、英小文字か数字で始める）。変更不可">
          <Input name="username" required autoComplete="off" />
        </Field>
        <Field label="表示名">
          <Input name="displayName" required autoComplete="off" />
        </Field>
        <Field label="役割">
          <select name="role" defaultValue="general" className="h-8 w-full rounded-md border border-border bg-background px-2">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="初期パスワード"
          hint={`${minPasswordLength} 文字以上・英字と数字を含む。初回ログイン時に変更されます`}
        >
          <Input name="password" type="password" required autoComplete="new-password" minLength={minPasswordLength} />
        </Field>
        <ActionButton type="submit" pending={creating} disabled={pending}>
          追加
        </ActionButton>
      </form>
    </section>
  );
}
