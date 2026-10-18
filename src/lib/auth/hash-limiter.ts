// パスワードのハッシュ（argon2id）を同時に回す数と、待ち行列の長さの上限（docs/spec.md の 2.1・3.6）。
// argon2 は Node.js の libuv のスレッドの溜め（既定 4 本）で回る。上限が無いと、同時の大量のログインの要求で
// 溜めが埋まり、ほかの仕事（ファイルの読み書きなど）と、ログインした人のロックの解除・再認証まで止まりうる。
//
// - **ログイン**（まだ誰か分からない要求）の枠：同時に `concurrency` 本まで、待ちは `queueLimit` 件まで。
//   超えた要求は待たせずにすぐ断る（HashBusyError。画面の API では 503 と Retry-After）。
// - **ログインした人**（ロックの解除・再認証・パスワードの変更・利用者を作る）の枠：ログインの枠とは別に
//   いつも1本を取っておき、待ちもログインの待ちより先に通す。ログインの要求が溢れても、ロック中の職員は戻れる。

export type HashLane = "login" | "priority";

export interface HashLimiterSettings {
  /** ログインの枠で、同時に回す数 */
  concurrency: number;
  /** ログインの枠で、待たせる数（これを超えたらすぐ断る）。ログインした人の枠の待ちも同じ数まで */
  queueLimit: number;
}

/** ログインした人の枠だけが使える、取っておく本数 */
export const PRIORITY_RESERVED = 1;
/** 断ったときに、もう一度試すまで待ってもらう秒数（Retry-After） */
export const HASH_BUSY_RETRY_AFTER_SECONDS = 5;

export class HashBusyError extends Error {
  constructor(readonly lane: HashLane) {
    super("パスワードの確かめが混んでいる");
    this.name = "HashBusyError";
  }
}

interface Waiter {
  start: () => void;
}

export class HashLimiter {
  private running = 0;
  private readonly queues: Record<HashLane, Waiter[]> = { login: [], priority: [] };

  constructor(private readonly settings: HashLimiterSettings) {}

  private limitOf(lane: HashLane): number {
    return lane === "priority" ? this.settings.concurrency + PRIORITY_RESERVED : this.settings.concurrency;
  }

  /** いま来たら、待たせずに断るか（遅らせる前に見て、断る要求を待たせない） */
  wouldReject(lane: HashLane): boolean {
    return this.running >= this.limitOf(lane) && this.queues[lane].length >= this.settings.queueLimit;
  }

  /** いま回している数と待っている数（試験・様子を見る用） */
  get stats() {
    return { running: this.running, login: this.queues.login.length, priority: this.queues.priority.length };
  }

  /** 枠を取って fn を回す。枠も待ちの席も無ければ HashBusyError */
  async run<T>(lane: HashLane, fn: () => Promise<T>): Promise<T> {
    if (this.running < this.limitOf(lane) && (lane === "priority" || this.queues.priority.length === 0)) {
      this.running += 1;
    } else {
      if (this.queues[lane].length >= this.settings.queueLimit) throw new HashBusyError(lane);
      // 枠が空いたら release が running を1つ増やしてから起こす
      await new Promise<void>((resolve) => this.queues[lane].push({ start: resolve }));
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private release() {
    this.running -= 1;
    // ログインした人の待ちを先に通す
    for (const lane of ["priority", "login"] as const) {
      while (this.running < this.limitOf(lane) && this.queues[lane].length > 0) {
        if (lane === "login" && this.queues.priority.length > 0) return;
        this.running += 1;
        this.queues[lane].shift()!.start();
      }
    }
  }
}

/**
 * プロセスで1つ（設定は最初に使うときに決める。試験では AuthContext に別のものを渡す）。
 * Next.js が route handler を別々に組んでも1つになるよう、globalThis に置く
 */
const KEY = Symbol.for("tsunagi-dicom.hash-limiter");
const holder = globalThis as typeof globalThis & { [KEY]?: HashLimiter };
export function sharedHashLimiter(settings: HashLimiterSettings): HashLimiter {
  return (holder[KEY] ??= new HashLimiter(settings));
}
