import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  hotp,
  otpauthUri,
  totpAt,
  totpStep,
  verifyTotp,
} from "@/lib/auth/totp";

// TOTP（RFC 6238・RFC 4226）。

// RFC 6238 の付録 B の SHA1 の秘密（"12345678901234567890"）
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("TOTP", () => {
  it("RFC 4226 の付録 D の HOTP の値と合う", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    expected.forEach((code, counter) => expect(hotp(secret, counter)).toBe(code));
  });

  it("RFC 6238 の付録 B の SHA1 の値（8 桁）の下 6 桁と合う", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) {
      expect(hotp(secret, totpStep(seconds * 1000), 8), String(seconds)).toBe(code);
      expect(totpAt(RFC_SECRET, seconds * 1000)).toBe(code.slice(2));
    }
  });

  it("base32 は行き来できる", () => {
    const buf = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(() => base32Decode("not base32!")).toThrow();
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it("前後1つの段（±30 秒）までを受け、その外は断る", () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    const at = (s: number) => totpAt(RFC_SECRET, s * 30_000);
    expect(verifyTotp(RFC_SECRET, at(step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, at(step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, at(step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, at(step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, at(step + 2), now)).toBeNull();
  });

  it("前に受けた段と、それより前の段は受けない（使い回しを断る）", () => {
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    const code = totpAt(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, code, now, step)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now - 30_000), now, step - 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, totpAt(RFC_SECRET, now + 30_000), now, step)).toBe(step + 1);
  });

  it("6 桁の数字でないものは断る（空白は落とす）", () => {
    const now = 1_800_000_000_000;
    const code = totpAt(RFC_SECRET, now);
    expect(verifyTotp(RFC_SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(totpStep(now));
    for (const bad of ["", "12345", "1234567", "abcdef", "12345a"]) expect(verifyTotp(RFC_SECRET, bad, now)).toBeNull();
  });

  it("認証のアプリへ渡す otpauth の URI を作る", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "tanaka");
    expect(uri).toBe(
      "otpauth://totp/tsunagi-dicom%3Atanaka?secret=JBSWY3DPEHPK3PXP&issuer=tsunagi-dicom&algorithm=SHA1&digits=6&period=30",
    );
  });
});
