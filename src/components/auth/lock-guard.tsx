"use client";

import { Lock, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, Input } from "@/components/ui/input";
import { ActionButton } from "@/components/ui/pending";
import { LOCK_COOKIE, type LockCookieReason } from "@/lib/auth/lock-cookie";
import { errorText, postJson } from "@/lib/client/post-json";
import { cn } from "@/lib/utils";

// 画面のロック（第7.0版 12 遵守事項⑥）。操作の無い時間が SCREEN_LOCK_MINUTES 続いたら、画面をぼかしてロックする。
// - ロックは BFF にも知らせ（/api/auth/lock）、ロックの間は画面の API と中継が 423 を返す（頁を開き直しても解けない）。
// - 解くのはパスワード。SCREEN_UNLOCK_REQUIRE_TOTP=true で TOTP を登録した利用者のときだけ（needsTotp）、6桁の欄も出す。
// - 同じブラウザのほかのタブとは localStorage で、最後の操作の時刻とロック・解除を分け合う。
// - BFF がロックしたら（ほかのタブのロックの知らせでも）頁を読み直す。描かないだけでは、ルーターのキャッシュと
//   頁に残った描画の元のデータ（RSC の payload）に、患者の情報が残るため。読み直した頁は、中身を描かない。
// - 画面の側と BFF の側のロックの状態がずれたら、いつも閉じる（ロック）側に倒す：
//   ロックの POST が失敗しても画面はロックのまま送り直す、どの要求でも 423 ならロックの画面にして読み直す、
//   BFF の状態を一定の間隔で確かめる（ほかのタブの知らせの取りこぼし）、解くのは BFF の確かめ（パスワード）が
//   通ってから（BFF がロックしていなくても確かめる）、ほかのタブの「解いた」の知らせは BFF に聞き直してから。
//   操作の無い時間は、このタブの時計の進み方で数え、ほかのタブの時刻は延ばす向きにだけ使う。
// - ロックはサーバーの側を正にする：ロックするときは、BFF へ知らせる前に、ロックの印の cookie
//   （src/lib/auth/lock-cookie.ts）を置く。知らせが届かなくても、読み直した頁・別のタブで開いた頁の要求に
//   印が付くので、BFF はその時点でロックし、中身なしで描く。BFF は、最後の操作の知らせから SCREEN_LOCK_MINUTES を
//   過ぎた要求でも、その時点でロックする。届いていないロックは sessionStorage にも持ち（読み直しの後も閉じたまま
//   送り直す）、BroadcastChannel で開いているほかのタブにも閉じてもらう。BFF のロックの解除の確かめが通るまで閉じる。
// - 操作があれば、15 秒に1回まで BFF に知らせる（サーバーの側のロックの時間を数え直す）。
// - ロックの画面から「ログアウト」できる（前の利用者のパスワードを知らない次の利用者が、ログインし直せるように）。
//   確認の窓を挟み、BFF がセッションを終えて（監査の記録に from: screen_lock を残す）から、ログインの頁へ移す。
//   ロックの間は中身を描いていないので、ログアウトで新しく消える画面の内容はない（確認の窓の 1 行は、ロックの前に入れて
//   保存していない入力が残らないことを知らせる）。ログアウトの前に、このブラウザに置いたロックの覚えを消す。

const LAST_ACTIVITY_KEY = "tsunagi:last-activity";
const LOCK_EVENT_KEY = "tsunagi:lock-event";
/** ヘッダーの「ロック」のボタンが投げる事件の名前 */
export const LOCK_NOW_EVENT = "tsunagi:lock-now";
/** まだ BFF に届いていないロック（タブごと。読み直しの後も残る） */
const PENDING_LOCK_KEY = "tsunagi:pending-lock";
/** ほかのタブとの知らせの名前（BroadcastChannel） */
const CHANNEL_NAME = "tsunagi:lock";
/**
 * 操作を BFF に知らせる間隔の下限。BFF は最後の知らせから SCREEN_LOCK_MINUTES でロックするので、
 * 画面の側より最大この時間だけ早くロックしうる（閉じる側）
 */
const PING_INTERVAL_MS = 15_000;
const CHECK_INTERVAL_MS = 5_000;

/** ロックの印の cookie を置く（src/lib/auth/lock-cookie.ts。BFF へ届く次の要求に必ず付く） */
function setLockCookie(reason: LockCookieReason) {
  try {
    document.cookie = `${LOCK_COOKIE}=${reason}; Path=/; Secure; SameSite=Strict`;
  } catch {
    // 置けなくても、画面はロックのまま、BFF へのロックの知らせを送り直す
  }
}

function clearLockCookieHere() {
  try {
    document.cookie = `${LOCK_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0`;
  } catch {
    // BFF の側でも、ロックの解除の確かめが通ったときに消している
  }
}

function readPending(): LockCookieReason | null {
  try {
    const v = window.sessionStorage.getItem(PENDING_LOCK_KEY);
    return v === "manual" || v === "client_idle" ? v : null;
  } catch {
    return null;
  }
}
/** BFF の状態（/api/auth/status）を確かめる間隔 */
const STATUS_INTERVAL_MS = 10_000;

/** BFF の状態の番号（200：ロックしていない、423：ロック中、401：ログインしていない）。つながらなければ 0 */
async function fetchStatus(): Promise<number> {
  try {
    const res = await fetch("/api/auth/status", { credentials: "same-origin", cache: "no-store" });
    return res.status;
  } catch {
    return 0;
  }
}

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
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const lastActivity = useRef(0);
  /** このタブの最後の操作（performance.now。時計の合わせ直しの影響を受けない） */
  const lastActivityMono = useRef(0);
  const lastPing = useRef(0);
  const lockedRef = useRef(initiallyLocked);
  /** BFF がロックした状態で描いた頁で、まだ解いていない（頁に患者の情報が無い） */
  const cleanRef = useRef(initiallyLocked);

  /**
   * 画面はロックしたが、BFF がロックしたことをまだ確かめていない（ロックの POST が通っていない）。その理由。
   * 頁の読み直しの後も残るよう、sessionStorage にも持つ（setPending）
   */
  const pendingLock = useRef<LockCookieReason | null>(null);
  /** ほかのタブとの知らせ（storage の事件の補助） */
  const channel = useRef<BroadcastChannel | null>(null);

  const setPending = useCallback((reason: LockCookieReason | null) => {
    pendingLock.current = reason;
    try {
      if (reason) window.sessionStorage.setItem(PENDING_LOCK_KEY, reason);
      else window.sessionStorage.removeItem(PENDING_LOCK_KEY);
    } catch {
      // 使えないブラウザでは、ロックの印の cookie と BFF の側のロックに任せる
    }
  }, []);

  /** BFF がロックしている（どこかの要求が 423 を返した）。必ずロックの画面にし、データを持つ頁なら読み直す */
  const onServerLocked = useCallback(() => {
    lockedRef.current = true;
    setPending(null);
    setLocked(true);
    if (!cleanRef.current) window.location.reload();
  }, [setPending]);

  /**
   * BFF にロックを知らせる。通ったら（または 423 なら）ほかのタブに知らせて頁を読み直す。
   * 通らなければ（網の切れ・BFF の失敗）、画面はロックのまま、間隔ごとに送り直す（閉じる側に倒す）。
   * 送る前にロックの印の cookie を置くので、知らせが届かなくても、次に BFF へ届く要求（読み直し・別のタブ）で
   * BFF がロックする
   */
  const confirmLock = useCallback(
    async (reason: LockCookieReason) => {
      setPending(reason);
      setLockCookie(reason);
      const res = await postJson("/api/auth/lock", { reason }, csrfToken);
      if (res.status === 401) {
        window.location.assign("/login");
        return;
      }
      if (res.ok || res.status === 423) {
        // BFF がロックしてから、ほかのタブに知らせ、頁を読み直す（読み直した頁は、中身を描かずにロックの画面を出す）。
        // ルーターのキャッシュ・頁に残った描画の元のデータ（RSC の payload）から、患者の情報を消すため
        setPending(null);
        writeShared(LOCK_EVENT_KEY, `lock:${Date.now()}`);
        channel.current?.postMessage({ type: "locked" });
        if (!cleanRef.current) window.location.reload();
      }
    },
    [csrfToken, setPending],
  );

  const lockNow = useCallback(
    async (reason: LockCookieReason, announce = true) => {
      if (lockedRef.current) return;
      // BFF の答えを待たずに、まず画面の中身を外し、ほかのタブにも閉じてもらう（受けたタブは知らせ返さない）
      lockedRef.current = true;
      setLocked(true);
      if (announce) channel.current?.postMessage({ type: "locking", reason });
      await confirmLock(reason);
    },
    [confirmLock],
  );

  useEffect(() => {
    lastActivity.current = Date.now();
    lastActivityMono.current = performance.now();
    lastPing.current = Date.now();

    const onActivity = () => {
      if (lockedRef.current) return;
      const now = Date.now();
      lastActivity.current = now;
      lastActivityMono.current = performance.now();
      writeShared(LAST_ACTIVITY_KEY, String(now));
      if (now - lastPing.current >= PING_INTERVAL_MS) {
        lastPing.current = now;
        void postJson("/api/auth/activity", {}, csrfToken).then((res) => {
          if (res.status === 423) {
            // BFF の側が先にロックしていた。読み直して、頁に残ったデータを消す
            onServerLocked();
          } else if (res.status === 401) {
            window.location.assign("/login");
          }
        });
      }
    };
    const events = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"] as const;
    for (const name of events) window.addEventListener(name, onActivity, { passive: true });

    // 読み直す前に BFF へ届かなかったロックが残っていれば（このタブの sessionStorage）、閉じたまま送り直す。
    // ふつうは、置いたロックの印の cookie で、BFF がこの頁を中身なしで描いている
    const stored = readPending();
    if (stored && initiallyLocked) setPending(null);
    else if (stored) void Promise.resolve().then(() => lockNow(stored));

    // 解いたという知らせだけでは中身を出さない。BFF がロックしていないと答えたときだけ戻す
    const onPeerUnlocked = () => {
      if (!lockedRef.current || pendingLock.current) return;
      void fetchStatus().then((status) => {
        if (status !== 200 || !lockedRef.current) return;
        lockedRef.current = false;
        cleanRef.current = false;
        lastActivity.current = Date.now();
        lastActivityMono.current = performance.now();
        setConfirmLogout(false);
        setLocked(false);
        router.refresh();
      });
    };

    // ほかのタブとの知らせ（storage の事件と BroadcastChannel）は補助。取りこぼしても、下の BFF の状態の確かめと、
    // このタブの時計と、ロックの印の cookie で閉じる
    const onStorage = (event: StorageEvent) => {
      if (event.key !== LOCK_EVENT_KEY || !event.newValue) return;
      if (event.newValue.startsWith("lock:")) {
        // ほかのタブが BFF をロックし終えてから知らせてくる。このタブも読み直して、頁に残ったデータを消す。
        // ロックした状態で描いた頁（データを持たない）は、読み直さなくてよい
        onServerLocked();
      } else if (event.newValue.startsWith("unlock:")) {
        onPeerUnlocked();
      }
    };
    window.addEventListener("storage", onStorage);
    try {
      channel.current = new BroadcastChannel(CHANNEL_NAME);
      channel.current.onmessage = (event: MessageEvent<{ type?: string; reason?: string }>) => {
        const message = event.data;
        if (message?.type === "locking") {
          // ほかのタブがロックし始めた（まだ BFF に届いていないかもしれない）。このタブも閉じて、自分でも送る
          void lockNow(message.reason === "client_idle" ? "client_idle" : "manual", false);
        } else if (message?.type === "locked") {
          onServerLocked();
        } else if (message?.type === "unlocked") {
          onPeerUnlocked();
        }
      };
    } catch {
      channel.current = null;
    }
    const onLockNow = () => void lockNow("manual");
    window.addEventListener(LOCK_NOW_EVENT, onLockNow);

    const idleMs = minutes * 60_000;
    const timer =
      minutes > 0
        ? window.setInterval(() => {
            if (lockedRef.current) return;
            // このタブの操作の時刻（時計の進み方だけで数え、時計の合わせ直しに引きずられない）で判断する。
            // ほかのタブの操作の時刻は延ばす向きにだけ使い、先の時刻（時計のずれ・壊れた値）は使わない
            const ownIdle = performance.now() - lastActivityMono.current;
            const shared = readShared(LAST_ACTIVITY_KEY);
            const now = Date.now();
            const sharedIdle = shared > 0 && shared <= now + 1000 ? now - shared : Infinity;
            if (Math.min(ownIdle, sharedIdle) >= idleMs) void lockNow("client_idle");
          }, CHECK_INTERVAL_MS)
        : undefined;

    // BFF の状態を一定の間隔で確かめる（操作の時刻は数え直さない）。ほかのタブ・BFF の側でロックしていたら閉じる
    const statusTimer = window.setInterval(() => {
      if (lockedRef.current && cleanRef.current) return;
      // ロックの POST が通っていなければ、送り直す（SCREEN_LOCK_MINUTES=0 でボタンでロックしたときも）
      if (lockedRef.current && pendingLock.current) {
        void confirmLock(pendingLock.current);
        return;
      }
      void fetchStatus().then((status) => {
        if (status === 423) onServerLocked();
        else if (status === 401) window.location.assign("/login");
      });
    }, STATUS_INTERVAL_MS);

    return () => {
      for (const name of events) window.removeEventListener(name, onActivity);
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LOCK_NOW_EVENT, onLockNow);
      if (timer !== undefined) window.clearInterval(timer);
      window.clearInterval(statusTimer);
      channel.current?.close();
      channel.current = null;
    };
  }, [csrfToken, minutes, initiallyLocked, lockNow, confirmLock, onServerLocked, setPending, router]);

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
    // BFF が確かめて通した（成功の応答）ときだけ、中身を出す。BFF はロックの印の cookie を消している
    lockedRef.current = false;
    cleanRef.current = false;
    setPending(null);
    clearLockCookieHere();
    lastActivity.current = Date.now();
    lastActivityMono.current = performance.now();
    writeShared(LAST_ACTIVITY_KEY, String(Date.now()));
    writeShared(LOCK_EVENT_KEY, `unlock:${Date.now()}`);
    channel.current?.postMessage({ type: "unlocked" });
    setConfirmLogout(false);
    setLocked(false);
    router.refresh();
  }

  /** ロックの画面からのログアウト。BFF がセッションを終えてから、ロックの覚えを消し、ログインの頁へ移す */
  async function onLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    const res = await postJson("/api/auth/logout", {}, csrfToken);
    // 401 は、もうセッションが無い（ログアウトと同じ結果）
    if (!res.ok && res.status !== 401) {
      setLoggingOut(false);
      setLogoutError(errorText(res));
      return;
    }
    setPending(null);
    clearLockCookieHere();
    try {
      window.localStorage.removeItem(LAST_ACTIVITY_KEY);
      window.localStorage.removeItem(LOCK_EVENT_KEY);
    } catch {
      // 使えないブラウザでは、置いていない
    }
    window.location.assign(res.data.next ?? "/login");
  }

  return (
    <>
      {/* ロックの間は中身を描かない（ぼかしただけでは、開発者の道具で中身を読めるため）。ぼかした地だけを出す */}
      <div
        data-testid="lockable-content"
        aria-hidden={locked || undefined}
        inert={locked || undefined}
        className={cn("flex min-h-0 flex-1 flex-col", locked && "pointer-events-none min-h-[60vh] select-none bg-surface/40 blur-md")}
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
              画面ロック中
            </h2>
            <p className="text-label">{needsTotp ? "パスワードと認証コードを入力してロックを解除してください" : "パスワードを入力してロックを解除してください"}</p>
            <Field label="パスワード">
              <Input name="password" type="password" autoComplete="current-password" required />
            </Field>
            {needsTotp && (
              <Field label="認証コード（6 桁）">
                <Input name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} required />
              </Field>
            )}
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            {/* 主な操作（ロック解除）を右端に置く */}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmLogout(true)}>
                <LogOut aria-hidden />
                ログアウト
              </Button>
              <ActionButton type="submit" pending={busy}>
                ロック解除
              </ActionButton>
            </div>
          </form>
        </div>
      )}
      <ConfirmDialog
        open={locked && confirmLogout}
        testId="logout-confirm"
        title="ログアウトする"
        body="ロックの前に入力して保存していない内容は残りません。"
        confirmLabel="ログアウトする"
        pending={loggingOut}
        error={logoutError}
        onConfirm={() => void onLogout()}
        onCancel={() => {
          setConfirmLogout(false);
          setLogoutError(null);
        }}
      />
    </>
  );
}

/** ヘッダーの「画面ロック」のボタン（すぐにロックする） */
export function LockNowButton() {
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => window.dispatchEvent(new Event(LOCK_NOW_EVENT))}>
      <Lock aria-hidden />
      画面ロック
    </Button>
  );
}
