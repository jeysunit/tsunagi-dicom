"use client";

import { LockNowButton } from "@/components/auth/lock-guard";
import { LogoutButton } from "@/components/auth/logout-button";
import { useScreenLocked } from "@/lib/client/screen-lock-store";

export interface HeaderUser {
  displayName: string;
  username: string;
  roleLabel: string;
  csrfToken: string;
}

// 上の帯の右端の、利用者・画面ロック・ログアウト。画面がロックしている間は何も描かない
// （ロックの外から、前の利用者の名前を見せず、操作もさせない。docs/spec.md の「画面のロック」）
export function HeaderAccount({ user }: { user: HeaderUser }) {
  const locked = useScreenLocked();
  if (locked) return null;
  return (
    <>
      <span className="h-5 w-px bg-border" aria-hidden="true" />
      <div className="flex flex-col leading-tight" data-testid="current-user">
        <span className="font-bold text-value">{user.displayName}</span>
        <span className="text-xs text-label">
          {user.username}（{user.roleLabel}）
        </span>
      </div>
      <LockNowButton />
      <LogoutButton csrfToken={user.csrfToken} />
    </>
  );
}
