// 資格情報の確かめ（パスワード・TOTP）の回数の上限（利用者ごとのログインの一時停止とは別）。
// 1 分ごとの枠で、接続元ごと（LOGIN_RATE_LIMIT_PER_MINUTE）と全体（LOGIN_RATE_LIMIT_GLOBAL_PER_MINUTE）を数える。
// 利用者名を引く前に数えるので、存在しない利用者名でも同じに数え、同じ答え（429）を返す。
// - 接続元は、信じるプロキシの設定ができるまで、要求のヘッダーの値（確かめていない接続元）しか無い。偽れるので、
//   全体の上限を最後の守りにする。ヘッダーが無い要求は、まとめて1つの接続元として数える。
// - 数はプロセスの記憶の中だけに持つ（再起動で消える。複数のプロセスで動かすと、それぞれで数える）。

export interface RateLimitSettings {
  perSourcePerMinute: number;
  globalPerMinute: number;
}

interface Window {
  start: number;
  count: number;
}

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  /** 1 回を数える。上限を超えていたら false（数えない） */
  take(source: string | null, settings: RateLimitSettings, nowMs: number): boolean {
    const global = this.window("*", nowMs);
    const key = `src:${source ?? "(なし)"}`;
    const own = this.window(key, nowMs);
    if (global.count >= settings.globalPerMinute || own.count >= settings.perSourcePerMinute) return false;
    global.count += 1;
    own.count += 1;
    return true;
  }

  private window(key: string, nowMs: number): Window {
    const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    let w = this.windows.get(key);
    if (!w || w.start !== start) {
      if (this.windows.size >= MAX_KEYS) {
        for (const [k, v] of this.windows) if (v.start !== start) this.windows.delete(k);
      }
      w = { start, count: 0 };
      this.windows.set(key, w);
    }
    return w;
  }
}

/** プロセスで1つの数え手（試験では AuthContext に別のものを渡す） */
export const defaultRateLimiter = new RateLimiter();
