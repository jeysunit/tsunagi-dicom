// 画面に何度も出す文言（docs/spec.md の 2.2 の用語集から選んだもの）。同じ場面の文言を頁ごとに書き分けないため、ここに1つだけ置く。

/** 役割で使えない頁 */
export const FORBIDDEN_PAGE = "この画面を表示する権限がありません";
/** 管理者だけの頁・操作 */
export const ADMIN_ONLY = "管理者のみ利用できます";
/** 一覧などを読めなかった（`検査を読み込めませんでした` の形） */
export const loadFailed = (what: string) => `${what}を読み込めませんでした`;
