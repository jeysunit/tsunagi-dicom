// 狭い画面（幅 768px 未満。Tailwind の md の手前）かどうか。検査の一覧は、狭い画面では上下に分けず、詳細を一覧の上に重ねる。
const QUERY = "(max-width: 767.98px)";

export function getNarrow(): boolean {
  return typeof window !== "undefined" && window.matchMedia(QUERY).matches;
}

export function getServerNarrow(): boolean {
  return false;
}

export function subscribeNarrow(listener: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", listener);
  return () => mql.removeEventListener("change", listener);
}
