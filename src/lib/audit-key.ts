import "server-only";
import { createHmac, hkdfSync } from "node:crypto";
import { getConfig } from "@/lib/config";

// 監査の記録のつなぎの鍵（docs/adr/0001-audit-chain-mac.md）。
// 鍵は SESSION_SECRET から HKDF-SHA256 で導く（用途の名前 info で、セッション・token・TOTP の秘密の鍵と分ける）。
// データベースのファイルには鍵を置かない。鍵を持たない者は、行を書き換えても hash（HMAC-SHA256）を作り直せない。
// 行には鍵の印（keyId）を持たせる。SESSION_SECRET を替えた後も、前の値を SESSION_SECRET_PREVIOUS_FILE で渡せば、
// 前の鍵で書いた行を確かめられる。

const SALT = Buffer.from("tsunagi-dicom", "utf8");
const INFO = "tsunagi-dicom/audit-chain/v1";
/** 鍵の印を導くときの文字列（鍵そのものは出さない） */
const KEY_ID_LABEL = "tsunagi-dicom/audit-chain/key-id";

export interface AuditKey {
  /** 鍵の印（16 桁の 16 進）。行の keyId に入れる */
  id: string;
  key: Buffer;
}

export interface AuditKeyring {
  /** 新しい行に使う鍵（いまの SESSION_SECRET から導いたもの） */
  current: AuditKey;
  /** 確かめに使える鍵（いまのものと、前に使っていたもの） */
  byId: ReadonlyMap<string, AuditKey>;
  /**
   * 鍵の古さの順（小さいほど古い）。SESSION_SECRET_PREVIOUS_FILE の行の順（上が古い）で、いまの鍵がいちばん新しい。
   * 鍵の切り替えは、新しい鍵へだけ受ける（前の鍵へ戻す行を作られても通さない）
   */
  rank: ReadonlyMap<string, number>;
}

export function deriveAuditKey(secret: string): AuditKey {
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), SALT, INFO, 32));
  const id = createHmac("sha256", key).update(KEY_ID_LABEL, "utf8").digest("hex").slice(0, 16);
  return { id, key };
}

export function auditKeyringFrom(sessionSecret: string, previous: readonly string[] = []): AuditKeyring {
  const current = deriveAuditKey(sessionSecret);
  const byId = new Map<string, AuditKey>();
  const rank = new Map<string, number>();
  previous.forEach((secret, i) => {
    const key = deriveAuditKey(secret);
    byId.set(key.id, key);
    rank.set(key.id, i);
  });
  byId.set(current.id, current);
  rank.set(current.id, previous.length);
  return { current, byId, rank };
}

let cached: { secret: string; previous: readonly string[]; ring: AuditKeyring } | undefined;

/** 設定（getConfig）の SESSION_SECRET と SESSION_SECRET_PREVIOUS_FILE から作った鍵の束 */
export function auditKeyring(): AuditKeyring {
  const config = getConfig();
  const previous = config.audit?.sessionSecretPrevious ?? [];
  if (!cached || cached.secret !== config.sessionSecret || cached.previous !== previous) {
    cached = { secret: config.sessionSecret, previous, ring: auditKeyringFrom(config.sessionSecret, previous) };
  }
  return cached.ring;
}
