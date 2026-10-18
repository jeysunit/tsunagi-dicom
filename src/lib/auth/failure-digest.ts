// ログインの失敗の監査の行の膨らみの抑え（docs/spec.md の 3.6）。
// 遅らせ（src/lib/auth/rate-limit.ts）の上限を超えた試みの失敗は、1行ずつではなく、1 分の枠ごとに
// 「誰が（利用者名か unknown）・どの理由で・何回・最初と最後の時刻」の1行にまとめて記録する。
// 上限の中の失敗は、これまでどおり1行ずつ残す。一時停止にしたこと（login_lock）も、いつも1行で残す。
// まとめる鍵は「利用者（存在する利用者名か unknown）×理由」なので、持つ数は利用者の数で決まり、
// 試された名前の数では増えない。まとめた行は、枠が替わった後の最初のログインの要求か、一定の間隔の片付け
// （src/lib/startup.ts）で書く。プロセスの記憶の中だけに持つので、書く前にプロセスが止まると、その枠の分は失われる。

export interface DigestActor {
  actorId: string;
  actorRole: string;
}

export interface DigestEntry extends DigestActor {
  reason: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
}

const WINDOW_MS = 60_000;

export class FailureDigest {
  private windowStart = 0;
  private readonly entries = new Map<string, DigestEntry>();

  add(actor: DigestActor, reason: string, at: Date): void {
    const start = Math.floor(at.getTime() / WINDOW_MS) * WINDOW_MS;
    if (this.entries.size === 0) this.windowStart = start;
    const key = `${actor.actorId}\u0000${actor.actorRole}\u0000${reason}`;
    const entry = this.entries.get(key);
    if (entry) {
      entry.count += 1;
      if (at > entry.lastAt) entry.lastAt = at;
    } else {
      this.entries.set(key, { ...actor, reason, count: 1, firstAt: at, lastAt: at });
    }
  }

  /** 枠が替わっていれば、まとめた分を渡して空にする。force なら枠の途中でも渡す */
  take(nowMs: number, force = false): DigestEntry[] {
    if (this.entries.size === 0) return [];
    const start = Math.floor(nowMs / WINDOW_MS) * WINDOW_MS;
    if (!force && start === this.windowStart) return [];
    const out = [...this.entries.values()];
    this.entries.clear();
    return out;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * プロセスで1つ（試験では AuthContext に別のものを渡す）。Next.js は起動の時の処理（instrumentation）と
 * route handler を別々に組むことがあるので、globalThis に1つだけ置いて、定期の片付けと同じものを使う
 */
const KEY = Symbol.for("tsunagi-dicom.failure-digest");
const holder = globalThis as typeof globalThis & { [KEY]?: FailureDigest };
export const defaultFailureDigest: FailureDigest = (holder[KEY] ??= new FailureDigest());
