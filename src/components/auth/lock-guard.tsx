"use client";

import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { errorText, postJson } from "@/lib/client/post-json";
import { cn } from "@/lib/utils";

// 画面のロック（第7.0版 12 遵守事項⑥）。操作の無い時間が SCREEN_LOCK_MINUTES 続いたら、画面をぼかしてロックする。
// - ロックは BFF にも知らせ（/api/auth/lock）、ロックの間は画面の API と中継が 423 を返す（頁を開き直しても解けない）。
// - 解くのはパスワード（と、登録していれば TOTP）。
// - 同じブラウザのほかのタブとは localStorage で、最後の操作の時刻とロック・解除を分け合う。
// - BFF がロックしたら（ほかのタブのロックの知らせでも）頁を読み直す。描かないだけでは、ルーターのキャッシュと
//   頁に残った描画の元のデータ（RSC の payload）に、患者の情報が残るため。読み直した頁は、中身を描かない。
// - 操作があれば、30 秒に1回まで BFF に知らせる（サーバーの側のロックの時間を数え直す）。

const LAST_ACTIVITY_KEY = "tsunagi:last-activity";
const LOCK_EVENT_KEY = "tsunagi:lock-event";
/** ヘッダーの「ロック」のボタンが投げる事件の名前 */
export const LOCK_NOW_EVENT = "tsunagi:lock-now";
const PING_INTERVAL_MS = 30_000;
const CHECK_INTERVAL_MS = 5_000;

function readShared(key: string): number {
  try {
    return Number(window.localStorage.getItem(key) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function writeShared(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 使えないブラウザでは、タブの中だけで数える
  }
}

export function LockGuard({
  csrfToken,
  minutes,
  needsTotp,
  initiallyLocked,
  children,
}: {
  csrfToken: string;
  minutes: number;
  needsTotp: boolean;
  initiallyLocked: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [locked, setLocked] = useState(initiallyLocked);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lastActivity = useRef(0);
  const lastPing = useRef(0);
  const lockedRef = useRef(initiallyLocked);
  /** BFF がロックした状態で描いた頁で、まだ解いていない（頁に患者の情報が無い） */
  const cleanRef = useRef(initiallyLocked);

  const lockNow = useCallback(
    async (reason: "client_idle" | "manual") => {
      if (lockedRef.current) return;
      lockedRef.current = true;
      setLocked(true);
      const res = await postJson("/api/auth/lock", { reason }, csrfToken);
      if (res.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (res.ok || res.status === 423) {
        // BFF がロックしてから、ほかのタブに知らせ、頁を読み直す（読み直した頁は、中身を描かずにロックの画面を出す）。
        // ルーターのキャッシュ・頁に残った描画の元のデータ（RSC の payload）から、患者の情報を消すため
        writeShared(LOCK_EVENT_KEY, `lock:${Date.now()}`);
        window.location.reload();
      }
    },
    [csrfToken],
  );

  useEffect(() => {
    lastActivity.current = Date.now();
    lastPing.current = Date.now();

    const onActivity = () => {
      if (lockedRef.current) return;
      const now = Date.now();
      lastActivity.current = now;
      writeShared(LAST_ACTIVITY_KEY, String(now));
      if (now - lastPing.current >= PING_INTERVAL_MS) {
        lastPing.current = now;
        void postJson("/api/auth/activity", {}, csrfToken).then((res) => {
          if (res.status === 423) {
            // BFF の側が先にロックしていた。読み直して、頁に残ったデータを消す
            lockedRef.current = true;
            setLocked(true);
            window.location.reload();
          } else if (res.status === 401) {
            window.location.assign("/login");
          }
        });
      }
    };
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const name of events) window.addEventListener(name, onActivity, { passive: true });

    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCK_EVENT_KEY || !event.newValue) return;
      if (event.newValue.startsWith("lock:")) {
        // ほかのタブが BFF をロックし終えてから知らせてくる。このタブも読み直して、頁に残ったデータを消す。
        // ロックした状態で描いた頁（データを持たない）は、読み直さなくてよい
        if (cleanRef.current) return;
        lockedRef.current = true;
        setLocked(true);
        window.location.reload();
      } else if (event.newValue.startsWith("unlock:")) {
        lockedRef.current = false;
        cleanRef.current = false;
        lastActivity.current = Date.now();
        setLocked(false);
        router.refresh();
      }
    };
    window.addEventListener("storage", onStorage);
    const onLockNow = () => void lockNow("manual");
    window.addEventListener(LOCK_NOW_EVENT, onLockNow);

    const timer =
      minutes > 0
        ? window.setInterval(() => {
            if (lockedRef.current) return;
            const last = Math.max(lastActivity.current, readShared(LAST_ACTIVITY_KEY));
            if (Date.now() - last >= minutes * 60_000) void lockNow("client_idle");
          }, CHECK_INTERVAL_MS)
        : undefined;

    return () => {
      for (const name of events) window.removeEventListener(name, onActivity);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LOCK_NOW_EVENT, onLockNow);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [csrfToken, minutes, lockNow, router]);

  async function onUnlock(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    const res = await postJson(
      "/api/auth/unlock",
      { password: form.get("password"), ...(needsTotp ? { code: form.get("code") } : {}) },
      csrfToken,
    );
    setBusy(false);
    if (res.data.next) {
      window.location.assign(res.data.next);
      return;
    }
    if (!res.ok) {
      setError(errorText(res));
      return;
    }
    lockedRef.current = false;
    cleanRef.current = false;
    lastActivity.current = Date.now();
    writeShared(LAST_ACTIVITY_KEY, String(Date.now()));
    writeShared(LOCK_EVENT_KEY, `unlock:${Date.now()}`);
    setLocked(false);
    router.refresh();
  }

  return (
    <>
      {/* ロックの間は中身を描かない（ぼかしただけでは、開発者の道具で中身を読めるため）。ぼかした地だけを出す */}
      <div
        data-testid="lockable-content"
        aria-hidden={locked || undefined}
        inert={locked || undefined}
        className={cn(locked && "pointer-events-none min-h-[60vh] select-none bg-surface/40 blur-md")}
      >
        {locked ? null : children}
      </div>
      {locked && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="screen-lock-title"
          data-testid="screen-lock"
          className="fixed inset-0 z-40 flex items-center justify-center bg-background/60"
        >
          <form
            onSubmit={(e) => void onUnlock(e)}
            className="w-full max-w-sm space-y-3 rounded-md border border-border bg-surface p-4"
          >
            <h2 id="screen-lock-title" className="flex items-center gap-1.5 font-bold text-value">
              <Lock aria-hidden className="size-4" />
              画面をロックしている
            </h2>
            <p className="text-label">続けるには、パスワード{needsTotp ? "と確認の番号" : ""}を入れる。</p>
            <Field label="パスワード">
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            {needsTotp && (
              <Field label="確認の番号（認証のアプリの 6 桁）">
                <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
              </Field>
            )}
            {error && (
              <p role="alert" className="text-sm text-red-300">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={busy}>
                ロックを解く
              </Button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

/** ヘッダーの「ロック」のボタン（すぐにロックする） */
export function LockNowButton() {
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event(LOCK_NOW_EVENT))}>
      <Lock aria-hidden />
      ロック
    </Button>
  );
}
