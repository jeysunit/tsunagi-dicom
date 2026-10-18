// 画面のロックの印の cookie（AUTH_MODE=local。docs/spec.md の 3.6）。
// 画面（ブラウザ）がロックしたいとき、BFF へのロックの知らせ（POST）を送る前に、この cookie を自分で置く。
// 網が切れて知らせが届かなくても、次にこのブラウザから BFF へ届く要求（頁の読み直し・別のタブで開く・画像の取得）
// には必ず付くので、BFF はその要求の時点でセッションをロックし、中身なしで描く（ロックはサーバーの側を正にする）。
// 消すのは、BFF がロックの解除を確かめたとき（パスワード。設定で TOTP も。src/app/api/auth/unlock/route.ts）と、
// ログイン・ログアウトのときだけ。印を置くことはロックの側にしか働かないので、偽っても害が無い。
// 値は理由（manual か client_idle）だけで、秘密は入れない。HttpOnly にしない（画面が置くため）。

export const LOCK_COOKIE = "__Host-tsunagi_lock";
export type LockCookieReason = "manual" | "client_idle";

export function parseLockCookie(value: string | undefined): LockCookieReason | null {
  if (value === undefined || value === "") return null;
  return value === "client_idle" ? "client_idle" : "manual";
}
