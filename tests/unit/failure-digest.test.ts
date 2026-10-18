import { describe, expect, it } from "vitest";
import { FailureDigest } from "@/lib/auth/failure-digest";

// ログインの失敗のまとめ（src/lib/auth/failure-digest.ts）。

const T = Date.UTC(2026, 9, 18, 9, 0, 0);
const at = (ms: number) => new Date(T + ms);
const sato = { actorId: "sato", actorRole: "viewer" };

describe("ログインの失敗のまとめ", () => {
  it("1 分の枠をまたいだ失敗は混ぜない。終わった枠の分だけを渡す", () => {
    const d = new FailureDigest();
    d.add(sato, "bad_password", at(59_000));
    d.add(sato, "bad_password", at(61_000));
    d.add(sato, "bad_password", at(62_000));
    // いまの枠（61 秒からの枠）はまだ渡さない
    const first = d.take(T + 62_000);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ count: 1, firstAt: at(59_000), lastAt: at(59_000) });
    expect(d.size).toBe(1);
    const second = d.take(T + 120_000);
    expect(second[0]).toMatchObject({ count: 2, firstAt: at(61_000), lastAt: at(62_000) });
    expect(d.size).toBe(0);
  });

  it("書けなかった分を戻すと、その間に足された同じ鍵の分と合わさる", () => {
    const d = new FailureDigest();
    d.add(sato, "bad_password", at(1_000));
    d.add(sato, "bad_password", at(2_000));
    const taken = d.take(T + 60_000);
    expect(d.size).toBe(0);
    d.add(sato, "bad_password", at(3_000));
    d.restore(taken);
    const again = d.take(T + 60_000);
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ count: 3, firstAt: at(1_000), lastAt: at(3_000) });
  });

  it("force なら、いまの枠の分も渡す", () => {
    const d = new FailureDigest();
    d.add(sato, "busy", at(1_000));
    expect(d.take(T + 2_000)).toEqual([]);
    expect(d.take(T + 2_000, true)).toHaveLength(1);
  });
});
