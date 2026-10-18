import { createHash } from "node:crypto";

// ログイン（利用者名とパスワード）の試みの遅らせ（利用者ごとのログインの一時停止とは別）。
// **断らずに遅らせる。** 上限を超えた試みは、答えを返すのを指数的に遅らせる（最大 MAX_DELAY_MS）。
// ほかの人が失敗を重ねても、正しい利用者が締め出されることは無い（遅くなるだけ）。締め出す仕組みは、
// 第7.0版 14 遵守事項⑥(6) の利用者ごとの一時停止だけ（時間で解け、管理者が解け、監査に残る）。
//
// 数え方：
// - **全体**（すべての試み）を数え、超えたら全員を遅らせる。鍵を変えても（利用者名・接続元を次々に替えても）
//   全体の数からは逃げられないので、すり抜けの最後の守りになる。
// - **利用者名ごと**：利用者名を正規化（NFKC・小文字・空白の除去）してから、SHA-256 で決まった数（BUCKETS）の
//   桶のどれかに入れて数える。大文字小文字・空白・全角半角を変えても同じ桶に入る。桶の数は決まっているので、
//   存在しない利用者名を次々に使っても記憶は増えない。存在する利用者名と存在しない利用者名を同じ形で数えるので、
//   遅れ方の違いから利用者名の有無を知られない（存在しない名前を1つの共通の鍵にまとめると、その鍵だけが混み、
//   遅れ方で有無が分かってしまうため、そうしない）。
// - 確かめた接続元があるときは「利用者名×接続元」も同じ形（別の桶の並び）で数える。X-Forwarded-For のような
//   偽れる値は使わない（信じるプロキシの設定ができるまで、確かめた接続元はいつも無い）。
// - 1 分ごとの枠で、枠が替わったら数を0に戻す。数はプロセスの記憶の中だけ（再起動で消える。複数のプロセスでは
//   それぞれで数える）。
// - 数えるのはログインの要求だけ。ログインの途中・後の確かめ（TOTP・ロックの解除・再認証・パスワードの変更）は、
//   利用者ごとの試みの枠（src/lib/auth/local-auth.ts の claimAttempt）で抑える。

export interface RateLimitSettings {
  /** 利用者名ごとに、1 分あたり遅らせずに通す回数 */
  perKeyPerMinute: number;
  /** 全体で、1 分あたり遅らせずに通す回数 */
  globalPerMinute: number;
}

export interface ThrottleResult {
  /** 答えを返す前に待つ時間 */
  delayMs: number;
  /** この枠で、はじめて上限を超えた（記録に残す） */
  firstOver: boolean;
  /** 全体の数が上限を超えている */
  globalOver: boolean;
  /** この試みで、はじめて全体の数が上限を超えた */
  firstGlobalOver: boolean;
}

const WINDOW_MS = 60_000;
/** 利用者名の桶の数（記憶はこれで決まり、試された名前の数では増えない） */
export const BUCKETS = 4096;
export const BASE_DELAY_MS = 250;
export const MAX_DELAY_MS = 10_000;

const delayFor = (over: number) => (over <= 0 ? 0 : Math.min(BASE_DELAY_MS * 2 ** (over - 1), MAX_DELAY_MS));

/** 利用者名の正規化（NFKC・小文字・空白の除去）。ログインで利用者を引くときも、同じ形にそろえる */
export function normalizeUsername(username: string): string {
  return username.normalize("NFKC").toLowerCase().replace(/\s+/gu, "").slice(0, 256);
}

function bucketOf(key: string): number {
  return createHash("sha256").update(key, "utf8").digest().readUInt32BE(0) % BUCKETS;
}

export class LoginThrottle {
  private windowStart = 0;
  private globalCount = 0;
  private readonly byName = new Uint32Array(BUCKETS);
  private readonly byNameAndSource = new Uint32Array(BUCKETS);

  /** 1 回を数え、待つ時間を返す（断らない） */
  take(username: string, verifiedSource: string | null, settings: RateLimitSettings, nowMs: number): ThrottleResult {
    const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    if (this.windowStart !== start) {
      this.windowStart = start;
      this.globalCount = 0;
      this.byName.fill(0);
      this.byNameAndSource.fill(0);
    }
    const name = normalizeUsername(username);
    this.globalCount += 1;
    let over = this.globalCount - settings.globalPerMinute;
    const globalOver = over > 0;
    const firstGlobalOver = over === 1;
    let firstOver = firstGlobalOver;

    const counters: [Uint32Array, number][] = [[this.byName, bucketOf(`user:${name}`)]];
    if (verifiedSource) counters.push([this.byNameAndSource, bucketOf(`user:${name}|src:${verifiedSource}`)]);
    for (const [table, i] of counters) {
      table[i] = table[i]! + 1;
      const own = table[i]! - settings.perKeyPerMinute;
      if (own === 1) firstOver = true;
      over = Math.max(over, own);
    }
    return { delayMs: delayFor(over), firstOver, globalOver, firstGlobalOver };
  }

  /** 数を持っている桶の数（試験用。BUCKETS を超えない） */
  get usedBuckets(): number {
    return this.byName.reduce((n, c) => n + (c > 0 ? 1 : 0), 0);
  }
}

/** プロセスで1つの数え手（試験では AuthContext に別のものを渡す） */
export const defaultLoginThrottle = new LoginThrottle();
