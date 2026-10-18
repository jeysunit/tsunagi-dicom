import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP（RFC 6238。HMAC-SHA1・6 桁・30 秒）。アプリのログインの二要素（第7.0版 14 遵守事項⑤・14.1.1 表14-1）。
// 時計のずれのために、前後1つの段（±30 秒）まで受け入れる。使った段は利用者ごとに覚え、同じ段・前の段を断る
// （src/lib/auth/users.ts の totpLastStep）。
// 試験（Playwright）からも読むので、server-only を付けない。

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("base32 でない文字がある");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 新しい TOTP の秘密（20 バイトの乱数の base32） */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** RFC 4226 の HOTP。digits の桁の文字列 */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(code % 10 ** digits).padStart(digits, "0");
}

export function totpAt(secretBase32: string, nowMs: number): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/**
 * 入力の値が、いまの段の前後1つまでのどれかに合えば、その段を返す。合わなければ null。
 * lastStep（前に受け入れた段）以下の段は受け入れない（使い回しを断る）。
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastStep: number | null = null,
): number | null {
  const given = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = hotp(secret, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(given))) return step;
  }
  return null;
}

/** 認証のアプリに読ませる otpauth の URI（QR にする） */
export function otpauthUri(secretBase32: string, username: string, issuer = "tsunagi-dicom"): string {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
