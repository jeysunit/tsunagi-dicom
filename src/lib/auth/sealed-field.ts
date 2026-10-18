import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// データベースに置く秘密（TOTP の秘密）の暗号化。AES-256-GCM。
// 鍵は SESSION_SECRET から HKDF-SHA256 で導く（用途の名前 info で、ほかの使い道の鍵と分ける）。
// 別の秘密を足さないのは、施設が守る秘密のファイルを増やさないため（SESSION_SECRET は 32 バイト以上の乱数で必須）。
// そのため、SESSION_SECRET を替えると、保存した TOTP の秘密は読めなくなり、利用者は TOTP を登録し直す
// （管理者の画面の「TOTP をやり直す」。docs/spec.md の 3.6）。
// aad（利用者の id）を一緒に確かめ、ほかの利用者の行へ写した値を使えないようにする。

const VERSION = "v1";
const INFO = "tsunagi-dicom/sealed-field/v1";
const SALT = Buffer.from("tsunagi-dicom", "utf8");

function key(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(sessionSecret, "utf8"), SALT, INFO, 32));
}

export function sealField(plain: string, sessionSecret: string, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(sessionSecret), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), body.toString("base64url"), tag.toString("base64url")].join(":");
}

/** 鍵・aad が違う、形が崩れているときは null */
export function openField(sealed: string, sessionSecret: string, aad: string): string | null {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [, iv, body, tag] = parts as [string, string, string, string];
    const decipher = createDecipheriv("aes-256-gcm", key(sessionSecret), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
