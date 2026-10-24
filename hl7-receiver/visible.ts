/* eslint-disable no-control-regex -- 制御文字そのものを見つけるための式。 */
/** 外から来た値を、端末と記録で見える形にする（design.md §14）。 */
export function visible(s: string): string {
  return s.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`
  );
}
