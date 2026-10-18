import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

// パスワードのハッシュ（argon2id。第7.0版 14 遵守事項②・⑥(3)）。平文には戻せない形で持つ。
// Node.js の node:crypto の argon2（v24.7 から）を使い、外の依存を足さない。
// 値は PHC の文字列（$argon2id$v=19$m=<KiB>,t=<回>,p=<並び>$<salt>$<hash>。base64 の = は付けない）。
// 強さは OWASP の Password Storage Cheat Sheet の argon2id の最小の例（m=19 MiB・t=2・p=1）に合わせる。

export interface Argon2Params {
  /** 使う記憶の大きさ（KiB） */
  memory: number;
  /** 回す回数 */
  passes: number;
  parallelism: number;
}

export const DEFAULT_ARGON2_PARAMS: Argon2Params = { memory: 19456, passes: 2, parallelism: 1 };

const SALT_BYTES = 16;
const TAG_BYTES = 32;
const VERSION = 19;

function derive(password: string, salt: Buffer, params: Argon2Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength,
        memory: params.memory,
        passes: params.passes,
      },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

const b64 = (buf: Buffer) => buf.toString("base64").replace(/=+$/, "");

export async function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const tag = await derive(password, salt, params, TAG_BYTES);
  return `$argon2id$v=${VERSION}$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

const PHC = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/**
 * 保存したハッシュの強さの値として受ける範囲。外れた値（壊れた行・書き換えた行）は確かめに回さない
 * （大きすぎる値で記憶と時間を使い切らせない。小さすぎる値は強さが足りない）
 */
export const ARGON2_PARAM_RANGE = {
  memory: { min: 8 * 1024, max: 256 * 1024 },
  passes: { min: 1, max: 10 },
  parallelism: { min: 1, max: 8 },
  saltBytes: { min: 8, max: 64 },
  tagBytes: { min: 16, max: 64 },
} as const;

const within = (v: number, r: { min: number; max: number }) => Number.isSafeInteger(v) && v >= r.min && v <= r.max;

interface ParsedHash {
  params: Argon2Params;
  salt: Buffer;
  tag: Buffer;
}

function parseHash(phc: string): ParsedHash | null {
  const m = PHC.exec(phc);
  if (!m || Number(m[1]) !== VERSION) return null;
  const params = { memory: Number(m[2]), passes: Number(m[3]), parallelism: Number(m[4]) };
  const salt = Buffer.from(m[5]!, "base64");
  const tag = Buffer.from(m[6]!, "base64");
  const r = ARGON2_PARAM_RANGE;
  if (
    !within(params.memory, r.memory) ||
    !within(params.passes, r.passes) ||
    !within(params.parallelism, r.parallelism) ||
    params.memory < 8 * params.parallelism ||
    !within(salt.length, r.saltBytes) ||
    !within(tag.length, r.tagBytes)
  ) {
    return null;
  }
  return { params, salt, tag };
}

/** 形の読めない値・版の違う値・強さの値が範囲の外の値は false（例外にしない） */
export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parseHash(phc);
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt, parsed.params, parsed.tag.length);
  return timingSafeEqual(actual, parsed.tag);
}

/**
 * 保存したハッシュが、いまの強さ（params）より弱いか（記憶・回数・並び・salt・tag のどれかが小さい）。
 * ログインに成功したとき、平文があるうちに作り直す（src/lib/auth/local-auth.ts）
 */
export function needsRehash(phc: string, params: Argon2Params = DEFAULT_ARGON2_PARAMS): boolean {
  const parsed = parseHash(phc);
  if (!parsed) return true;
  return (
    parsed.params.memory < params.memory ||
    parsed.params.passes < params.passes ||
    parsed.params.parallelism < params.parallelism ||
    parsed.salt.length < SALT_BYTES ||
    parsed.tag.length < TAG_BYTES
  );
}

/** 知らない利用者名でも同じほどの時間をかける（利用者名の有無を時間で知られないように）ための、捨てるハッシュ */
let dummy: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword("tsunagi-dicom-dummy-password-0");
  await verifyPassword(password, await dummy);
}
