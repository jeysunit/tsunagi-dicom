// ログイン（利用者名とパスワード）の試みの遅らせ（利用者ごとのログインの一時停止とは別）。
// **断らずに遅らせる。** 上限を超えた試みは、答えを返すのを指数的に遅らせる（最大 MAX_DELAY_MS）。
// ほかの人が失敗を重ねても、正しい利用者が締め出されることは無い（遅くなるだけ）。締め出す仕組みは、
// 第7.0版 14 遵守事項⑥(6) の利用者ごとの一時停止だけ（時間で解け、管理者が解け、監査に残る）。
// - 数える鍵は「利用者名」（打たれた名前。存在しない利用者名も同じに数える）と、確かめた接続元があれば「利用者名×接続元」。
//   X-Forwarded-For のような偽れる値は鍵に使わない（信じるプロキシの設定ができるまで、確かめた接続元はいつも無い）。
// - 全体（すべての試み）も数え、超えたら同じように遅らせる（締め出さない）。
// - 1 分ごとの枠。数はプロセスの記憶の中だけ（再起動で消える。複数のプロセスではそれぞれで数える）。
//   覚える鍵の数には上限（MAX_KEYS）があり、あふれたら、その分は全体の数だけで遅らせる。
// - 数えるのはログインの要求だけ。ログインの途中・後の確かめ（TOTP・ロックの解除・再認証・パスワードの変更）は、
//   利用者ごとの試みの枠（src/lib/auth/local-auth.ts の claimAttempt）で抑える。

export interface RateLimitSettings {
  /** 鍵ごとに、1 分あたり遅らせずに通す回数 */
  perKeyPerMinute: number;
  /** 全体で、1 分あたり遅らせずに通す回数 */
  globalPerMinute: number;
}

export interface ThrottleResult {
  /** 答えを返す前に待つ時間 */
  delayMs: number;
  /** この枠で、はじめて上限を超えた（記録に残す） */
  firstOver: boolean;
}

const WINDOW_MS = 60_000;
export const MAX_KEYS = 10_000;
export const BASE_DELAY_MS = 250;
export const MAX_DELAY_MS = 10_000;

const delayFor = (over: number) => (over <= 0 ? 0 : Math.min(BASE_DELAY_MS * 2 ** (over - 1), MAX_DELAY_MS));

export class LoginThrottle {
  private windowStart = 0;
  private globalCount = 0;
  private readonly counts = new Map<string, number>();

  /** 1 回を数え、待つ時間を返す（断らない） */
  take(keys: string[], settings: RateLimitSettings, nowMs: number): ThrottleResult {
    const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    if (this.windowStart !== start) {
      this.windowStart = start;
      this.globalCount = 0;
      this.counts.clear();
    }
    this.globalCount += 1;
    let over = this.globalCount - settings.globalPerMinute;
    let firstOver = over === 1;
    for (const key of keys) {
      let count = this.counts.get(key);
      if (count === undefined) {
        if (this.counts.size >= MAX_KEYS) continue;
        count = 0;
      }
      count += 1;
      this.counts.set(key, count);
      const own = count - settings.perKeyPerMinute;
      if (own === 1) firstOver = true;
      over = Math.max(over, own);
    }
    return { delayMs: delayFor(over), firstOver };
  }

  /** 覚えている鍵の数（試験用） */
  get keyCount(): number {
    return this.counts.size;
  }
}

/** ログインの試みの鍵。利用者名は小文字にそろえる。確かめた接続元があるときだけ「利用者名×接続元」も数える */
export function throttleKeys(username: string, verifiedSource: string | null): string[] {
  const name = `user:${username.trim().toLowerCase().slice(0, 64)}`;
  return verifiedSource ? [name, `${name}|src:${verifiedSource}`] : [name];
}

/** プロセスで1つの数え手（試験では AuthContext に別のものを渡す） */
export const defaultLoginThrottle = new LoginThrottle();
