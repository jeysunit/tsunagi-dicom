import commonPasswords from "@/lib/auth/common-passwords.json";

// パスワードの規則（docs/spec.md の 3.6、第7.0版 14 遵守事項⑥(1)・14.1.1）。
// - 二要素が必須（MFA_REQUIRED=true）なら 8 文字以上、そうでなければ 13 文字以上。
// - 英字と数字の混在。
// - よくあるパスワードの一覧（common-passwords.json。元は @zxcvbn-ts/language-common、MIT）にあるもの、
//   利用者名を含むものを断る。
// - 定期的な変更は求めない（期限を持たない）。

export const MAX_PASSWORD_LENGTH = 128;

const COMMON = new Set<string>(commonPasswords as string[]);

export interface PasswordPolicyOptions {
  mfaRequired: boolean;
  username?: string;
}

export function minPasswordLength(mfaRequired: boolean): number {
  return mfaRequired ? 8 : 13;
}

/** 規則に合わない理由を並べる（空なら合う）。パスワードそのものは文言に入れない */
export function checkPassword(password: string, options: PasswordPolicyOptions): string[] {
  const problems: string[] = [];
  const min = minPasswordLength(options.mfaRequired);
  // 文字の数は、サロゲートの組を1文字と数える
  const length = [...password].length;
  // 画面に出す文言（docs/spec.md の 2.2）
  if (length < min) problems.push(`${min} 文字以上にしてください`);
  if (length > MAX_PASSWORD_LENGTH) problems.push(`${MAX_PASSWORD_LENGTH} 文字以下にしてください`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(password)) problems.push("制御文字は使えません");
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) problems.push("英字と数字を含めてください");
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push("よく使われるパスワードのため使えません");
  const username = options.username?.trim().toLowerCase();
  if (username && username.length >= 3 && lower.includes(username)) problems.push("ユーザーIDを含むパスワードは使えません");
  return problems;
}
