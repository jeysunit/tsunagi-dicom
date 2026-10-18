import { describe, expect, it } from "vitest";
import {
  ARGON2_PARAM_RANGE,
  DEFAULT_ARGON2_PARAMS,
  hashPassword,
  needsRehash,
  verifyPassword,
} from "@/lib/auth/password-hash";

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

  it("保存したハッシュの強さの値が範囲の外なら、確かめに回さない（大きすぎる・小さすぎる値）", async () => {
    const hash = await hashPassword("kq7vz2mw");
    const withParams = (m: number, t: number, p: number) => hash.replace("m=19456,t=2,p=1", `m=${m},t=${t},p=${p}`);
    const max = ARGON2_PARAM_RANGE;
    for (const bad of [
      withParams(max.memory.max + 1, 2, 1),
      withParams(4096, 2, 1),
      withParams(19456, max.passes.max + 1, 1),
      withParams(19456, 0, 1),
      withParams(19456, 2, max.parallelism.max + 1),
      withParams(19456, 2, 0),
      withParams(Number.MAX_SAFE_INTEGER * 10, 2, 1),
    ]) {
      expect(await verifyPassword("kq7vz2mw", bad)).toBe(false);
      expect(needsRehash(bad)).toBe(true);
    }
  });

  it("いまの強さより弱いハッシュは作り直しの対象。同じか強いものは対象にしない", async () => {
    const weak = await hashPassword("kq7vz2mw", { memory: 8192, passes: 1, parallelism: 1 });
    expect(await verifyPassword("kq7vz2mw", weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hashPassword("kq7vz2mw"))).toBe(false);
    expect(needsRehash(await hashPassword("kq7vz2mw", { memory: 32768, passes: 3, parallelism: 1 }))).toBe(false);
  });
});
