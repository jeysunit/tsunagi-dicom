import { describe, expect, it } from "vitest";
import { DEFAULT_ARGON2_PARAMS, hashPassword, verifyPassword } from "@/lib/auth/password-hash";

// パスワードのハッシュ（argon2id。第7.0版 14 遵守事項②・⑥(3)）。

describe("パスワードのハッシュ", () => {
  it("argon2id の PHC の形で持ち、平文を含まない", async () => {
    const hash = await hashPassword("kq7vz2mw-secret");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
    expect(hash).not.toContain("kq7vz2mw");
    expect(DEFAULT_ARGON2_PARAMS).toEqual({ memory: 19456, passes: 2, parallelism: 1 });
  });

  it("同じパスワードでも、毎回ちがう salt で違う値になる", async () => {
    expect(await hashPassword("kq7vz2mw")).not.toBe(await hashPassword("kq7vz2mw"));
  });

  it("合うパスワードだけを通す", async () => {
    const hash = await hashPassword("kq7vz2mw");
    expect(await verifyPassword("kq7vz2mw", hash)).toBe(true);
    expect(await verifyPassword("kq7vz2mW", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("形の崩れた値・書き換えた値は通さない（例外にしない）", async () => {
    const hash = await hashPassword("kq7vz2mw");
    expect(await verifyPassword("kq7vz2mw", "plain-text")).toBe(false);
    expect(await verifyPassword("kq7vz2mw", hash.replace("v=19", "v=16"))).toBe(false);
    expect(await verifyPassword("kq7vz2mw", hash.replace("$argon2id$", "$argon2i$"))).toBe(false);
    // 末尾の字は使わない bit を含むことがあるので、末尾から 10 字目を替える
    const i = hash.length - 10;
    const tampered = hash.slice(0, i) + (hash[i] === "A" ? "B" : "A") + hash.slice(i + 1);
    expect(await verifyPassword("kq7vz2mw", tampered)).toBe(false);
  });
});
