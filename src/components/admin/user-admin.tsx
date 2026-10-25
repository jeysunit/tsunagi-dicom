"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/input";
import { ActionButton } from "@/components/ui/pending";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ROLE_LABELS, ROLES, isRole, type Role } from "@/lib/auth/roles";
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
  /** 確認の窓に出している変更（役割の変更・無効にする・二要素認証のリセット）。「変更する」などを押したら送る */
  const [confirm, setConfirm] = useState<{ title: string; body: string; confirmLabel: string; run: () => void } | null>(null);

  /** 役割の選択欄で選んだとき：すぐには送らず、誰を何から何へ替えるかを確認の窓に出す（選択欄は確定まで元の役割のまま） */
  function askRole(u: UserRowView, role: Role) {
    if (role === u.role) return;
    const from = isRole(u.role) ? ROLE_LABELS[u.role] : u.role;
    setConfirm({
      title: `${u.username}（${u.displayName}）の役割を変更しますか？`,
      body: `${from} → ${ROLE_LABELS[role]}。${
        role === "admin" ? "削除・ユーザー管理・システムの設定ができるようになります" : "削除・ユーザー管理・システムの設定ができなくなります"
      }。役割はあとで戻せます。`,
      confirmLabel: "変更する",
      run: () => void change(u.id, { role }, `${u.username} の役割を「${ROLE_LABELS[role]}」に変更しました`),
    });
  }

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
      {/* 確認の窓（docs/design-system/components.md）。押したら窓を閉じてから送る（再認証を求められたら、画面の再認証の欄に移る） */}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.title ?? ""}
        body={confirm?.body ?? ""}
        confirmLabel={confirm?.confirmLabel ?? ""}
        testId="user-confirm"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const run = confirm?.run;
          setConfirm(null);
          run?.();
        }}
      />
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
          <TableRow>
            <TableHead>ユーザーID</TableHead>
            <TableHead>表示名</TableHead>
            <TableHead>役割</TableHead>
            <TableHead>状態</TableHead>
            <TableHead>二要素認証</TableHead>
            <TableHead>最終ログイン</TableHead>
            <TableHead>作成日</TableHead>
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
                    if (isRole(role)) askRole(u, role);
                  }}
                  className="h-7 rounded-md border border-border-input bg-background px-1"
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
                {u.lockedUntil && <span className="block text-xs text-label">ロック中（{u.lockedUntil} まで）</span>}
              </TableCell>
              <TableCell>{u.totpEnabled ? "設定済み" : "未設定"}</TableCell>
              <TableCell data-testid="last-login">
                {u.lastLogin ?? "—"}
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
                      // 無効にするのは確認の窓を挟む（ログイン中のセッションも終わる）。有効に戻すのはすぐ送る
                      u.status === "active"
                        ? setConfirm({
                            title: `${u.username}（${u.displayName}）を無効にしますか？`,
                            body: "ログイン中のセッションは終わり、ログインできなくなります。「有効にする」で戻せます。",
                            confirmLabel: "無効にする",
                            run: () => void change(u.id, { status: "disabled" }, `${u.username} を無効にしました`),
                          })
                        : void change(u.id, { status: "active" }, `${u.username} を有効にしました`)
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
                    onClick={() =>
                      setConfirm({
                        title: `${u.username}（${u.displayName}）の二要素認証をリセットしますか？`,
                        body: "登録した認証アプリは使えなくなり、ログイン中のセッションも終わります。次回のログイン時に設定し直します。",
                        confirmLabel: "リセットする",
                        run: () =>
                          void change(u.id, { resetTotp: true }, `${u.username} の二要素認証をリセットしました（次回ログイン時に再設定）`),
                      })
                    }
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
          <select name="role" defaultValue="general" className="h-8 w-full rounded-md border border-border-input bg-background px-2">
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
