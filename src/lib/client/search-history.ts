// 検査の一覧の検索語の履歴（docs/spec.md の 3.1「検索語の履歴」）。
// 直前に使った検索語を新しい順に 5 件まで持つ。同じ語は 1 件にまとめて先頭へ移す。
// 画面を開いている間だけ持つ（この変数だけ。ブラウザーの保存先には書かない。患者 ID・氏名が共用の端末に残らないように）。
// 書くのは利用者の操作（ブラウザーの中）だけで、サーバーの描画では空のまま（利用者をまたいで共有しない）。

export const SEARCH_HISTORY_MAX = 5;

let recent: string[] = [];

/** 検索を実行した語を覚える。空・空白だけの語は覚えない */
export function rememberSearch(word: string): void {
  const w = word.trim();
  if (!w) return;
  recent = [w, ...recent.filter((x) => x !== w)].slice(0, SEARCH_HISTORY_MAX);
}

/** 新しい順の検索語 */
export function recentSearches(): readonly string[] {
  return recent;
}

/** 試験のために、覚えた語を消す */
export function forgetSearches(): void {
  recent = [];
}
