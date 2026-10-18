// 利用者名の形。小文字の英字・数字で始め、英小文字・数字・`.`・`_`・`-` の 3〜64 文字。
// 作った後は変えない（監査の記録の「誰が」に使う）。
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
export const USERNAME_HINT = "英小文字・数字で始め、英小文字・数字・. _ - の 3〜64 文字";

export function isValidUsername(value: string): boolean {
  return USERNAME_PATTERN.test(value);
}
