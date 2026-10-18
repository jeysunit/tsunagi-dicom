import { describe, expect, it } from "vitest";
import commonPasswords from "@/lib/auth/common-passwords.json";
import { checkPassword, MAX_PASSWORD_LENGTH, minPasswordLength } from "@/lib/auth/password-policy";

// パスワードの規則（第7.0版 14 遵守事項⑥(1)・14.1.1）。

describe("パスワードの規則", () => {
  it("二要素が必須なら 8 文字以上、そうでなければ 13 文字以上", () => {
    expect(minPasswordLength(true)).toBe(8);
    expect(minPasswordLength(false)).toBe(13);
    expect(checkPassword("kq7vz2mw", { mfaRequired: true })).toEqual([]);
    expect(checkPassword("kq7vz2m", { mfaRequired: true })).toEqual(["8 文字以上にする"]);
    expect(checkPassword("kq7vz2mwpx4ra", { mfaRequired: false })).toEqual([]);
    expect(checkPassword("kq7vz2mwpx4r", { mfaRequired: false })).toEqual(["13 文字以上にする"]);
  });

  it("英字と数字の混在を求める（記号は使ってよい）", () => {
    expect(checkPassword("kqvzxmwpra", { mfaRequired: true })).toEqual(["英字と数字を両方含める"]);
    expect(checkPassword("8264019375", { mfaRequired: true })).toEqual(["英字と数字を両方含める"]);
    expect(checkPassword("kq7v-z2m!w", { mfaRequired: true })).toEqual([]);
  });

  it("よく使われるパスワードの一覧にあるものを断る（大文字・小文字を区別しない）", () => {
    for (const pw of ["password1", "Passw0rd", "1qaz2wsx", "QWERTY123", "abcd1234"]) {
      expect(checkPassword(pw, { mfaRequired: true }), pw).toContain("よく使われるパスワードの一覧にある（推測されやすい）");
    }
  });

  it("同梱した一覧は、ほかの決まりを満たす語だけで、空でない", () => {
    const list = commonPasswords as string[];
    expect(list.length).toBeGreaterThan(1000);
    for (const w of list) {
      expect(w.length).toBeGreaterThanOrEqual(8);
      expect(w).toMatch(/[a-z]/);
      expect(w).toMatch(/[0-9]/);
      expect(w).toBe(w.toLowerCase());
    }
  });

  it("利用者名を含むものを断る", () => {
    expect(checkPassword("tanaka-2026x", { mfaRequired: true, username: "tanaka" })).toEqual(["利用者名を含めない"]);
    expect(checkPassword("TANAKA-2026x", { mfaRequired: true, username: "tanaka" })).toEqual(["利用者名を含めない"]);
    // 短い利用者名（2 文字以下）は見ない（ほとんどの語に含まれてしまうため）
    expect(checkPassword("kq7vz2mw", { mfaRequired: true, username: "kq" })).toEqual([]);
  });

  it("長すぎるもの・制御文字を含むものを断る", () => {
    expect(checkPassword(`a1${"x".repeat(MAX_PASSWORD_LENGTH)}`, { mfaRequired: true })).toEqual([
      `${MAX_PASSWORD_LENGTH} 文字以下にする`,
    ]);
    expect(checkPassword("kq7vz2mw\n", { mfaRequired: true })).toEqual(["制御文字は使えない"]);
  });

  it("日本語の文字も1文字と数える（英字と数字の混在は別に要る）", () => {
    expect(checkPassword("つなぎ画像a1x", { mfaRequired: true })).toEqual([]);
    expect(checkPassword("つなぎa1", { mfaRequired: true })).toEqual(["8 文字以上にする"]);
  });
});
