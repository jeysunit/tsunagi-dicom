import { describe, expect, it } from "vitest";
import { HashBusyError, HashLimiter, PRIORITY_RESERVED } from "@/lib/auth/hash-limiter";

// パスワードのハッシュを同時に回す数と待ち行列の上限（docs/spec.md の 3.6）。
// 回す中身は、試験が手で終わらせる約束にする（argon2 の速さに依らない）。

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
}

/** 中身が始まったことと終わらせる手を控える */
function job(started: string[], name: string) {
  const g = gate();
  return {
    fn: async () => {
      started.push(name);
      await g.promise;
      return name;
    },
    finish: g.open,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("パスワードのハッシュの同時の数と待ち行列", () => {
  it("ログインの枠は、決めた数まで同時に回し、決めた数まで待たせ、超えたらすぐ断る", async () => {
    const limiter = new HashLimiter({ concurrency: 2, queueLimit: 1 });
    const started: string[] = [];
    const a = job(started, "a");
    const b = job(started, "b");
    const c = job(started, "c");
    const pa = limiter.run("login", a.fn);
    const pb = limiter.run("login", b.fn);
    const pc = limiter.run("login", c.fn);
    await tick();
    expect(started).toEqual(["a", "b"]);
    expect(limiter.stats).toEqual({ running: 2, login: 1, priority: 0 });
    expect(limiter.wouldReject("login")).toBe(true);
    await expect(limiter.run("login", async () => "d")).rejects.toBeInstanceOf(HashBusyError);

    a.finish();
    expect(await pa).toBe("a");
    await tick();
    expect(started).toEqual(["a", "b", "c"]);
    b.finish();
    c.finish();
    expect(await Promise.all([pb, pc])).toEqual(["b", "c"]);
    expect(limiter.stats).toEqual({ running: 0, login: 0, priority: 0 });
  });

  it("ログインの枠が埋まっていても、ログインした人の枠は取っておいた1本で、すぐに回る", async () => {
    expect(PRIORITY_RESERVED).toBe(1);
    const limiter = new HashLimiter({ concurrency: 1, queueLimit: 0 });
    const started: string[] = [];
    const a = job(started, "login");
    const pa = limiter.run("login", a.fn);
    await tick();
    expect(limiter.wouldReject("login")).toBe(true);
    await expect(limiter.run("login", async () => "x")).rejects.toBeInstanceOf(HashBusyError);
    // ログインした人（ロックの解除・再認証）は通る
    expect(await limiter.run("priority", async () => "unlock")).toBe("unlock");
    a.finish();
    await pa;
  });

  it("枠が空いたら、ログインした人の待ちを、ログインの待ちより先に通す", async () => {
    const limiter = new HashLimiter({ concurrency: 1, queueLimit: 4 });
    const started: string[] = [];
    const first = job(started, "login-1");
    const reserved = job(started, "priority-0");
    const p1 = limiter.run("login", first.fn);
    const p0 = limiter.run("priority", reserved.fn);
    await tick();
    expect(started).toEqual(["login-1", "priority-0"]);
    // どちらの枠も埋まった。ログインの待ち → ログインした人の待ちの順に来る
    const l2 = job(started, "login-2");
    const pr = job(started, "priority-1");
    const p2 = limiter.run("login", l2.fn);
    const p3 = limiter.run("priority", pr.fn);
    await tick();
    expect(limiter.stats).toMatchObject({ running: 2, login: 1, priority: 1 });
    first.finish();
    await p1;
    await tick();
    expect(started).toEqual(["login-1", "priority-0", "priority-1"]);
    reserved.finish();
    pr.finish();
    await Promise.all([p0, p3]);
    await tick();
    expect(started.at(-1)).toBe("login-2");
    l2.finish();
    await p2;
  });

  it("中身が失敗しても、枠を返す", async () => {
    const limiter = new HashLimiter({ concurrency: 1, queueLimit: 0 });
    await expect(
      limiter.run("login", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(limiter.stats.running).toBe(0);
    expect(await limiter.run("login", async () => "ok")).toBe("ok");
  });
});
