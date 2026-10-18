// ログインの失敗の監査の行の膨らみの抑え（docs/spec.md の 3.6）。
// 遅らせ（src/lib/auth/rate-limit.ts）の上限を超えた試みの失敗は、1行ずつではなく、1 分の枠ごとに
// 「誰が（利用者名か unknown）・どの理由で・何回・最初と最後の時刻」の1行にまとめて記録する。
// 上限の中の失敗は、これまでどおり1行ずつ残す。一時停止にしたこと（login_lock）も、いつも1行で残す。
// まとめる鍵は「1 分の枠×利用者（存在する利用者名か unknown）×理由」なので、持つ数は利用者の数で決まり、
// 試された名前の数では増えない。枠をまたいだ失敗は混ぜない。まとめた行は、終わった枠の分だけを、
// 枠が替わった後の最初のログインの要求か、一定の間隔の片付け（src/lib/startup.ts）で書く。
// 書くのに失敗した分は戻し、次に書き直す。プロセスの記憶の中だけに持つので、書く前にプロセスが止まると、
// その分は失われる。

export interface DigestActor {
  actorId: string;
  actorRole: string;
}

export interface DigestEntry extends DigestActor {
  reason: string;
  count: number;
  firstAt: Date;
  lastAt: Date;
  /** 1 分の枠の始まり（UNIX ミリ秒） */
  windowStart: number;
}

const WINDOW_MS = 60_000;
const windowOf = (ms: number) => Math.floor(ms / WINDOW_MS) * WINDOW_MS;
const keyOf = (e: Pick<DigestEntry, "windowStart" | "actorId" | "actorRole" | "reason">) =>
  `${e.windowStart}\u0000${e.actorId}\u0000${e.actorRole}\u0000${e.reason}`;

export class FailureDigest {
  private readonly entries = new Map<string, DigestEntry>();

  add(actor: DigestActor, reason: string, at: Date): void {
    this.merge({ ...actor, reason, count: 1, firstAt: at, lastAt: at, windowStart: windowOf(at.getTime()) });
  }

  /** 終わった枠（いまの枠より前）の分を渡して、持ち分から外す。force なら、いまの枠の分も渡す */
  take(nowMs: number, force = false): DigestEntry[] {
    const current = windowOf(nowMs);
    const out: DigestEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (force || entry.windowStart < current) {
        out.push(entry);
        this.entries.delete(key);
      }
    }
    return out.sort((a, b) => a.windowStart - b.windowStart);
  }

  /** 書けなかった分を戻す（その間に足された同じ鍵の分と合わせる） */
  restore(entries: DigestEntry[]): void {
    for (const entry of entries) this.merge(entry);
  }

  private merge(entry: DigestEntry): void {
    const key = keyOf(entry);
    const have = this.entries.get(key);
    if (!have) {
      this.entries.set(key, { ...entry });
      return;
    }
    have.count += entry.count;
    if (entry.firstAt < have.firstAt) have.firstAt = entry.firstAt;
    if (entry.lastAt > have.lastAt) have.lastAt = entry.lastAt;
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
