// 詳細のパネルの「すべての項目」を開いているか。行を替えても開いたままにするため、ブラウザの localStorage に覚える
// （境目の位置と同じ：この端末のこのブラウザごと。サーバーの利用者の設定には持たない。読めない・書けないときは、頁を開いている間だけ覚える）。
// 既定は閉じる（見出しの 1〜2 行とシリーズの並びだけを出す）。

export const DETAIL_OPEN_KEY = "tsunagi-dicom.detailAllItems";

/** 覚えた文字列を開閉にする。`1` だけが開く。それ以外（空・読めない値）は閉じる */
export function parseDetailOpen(raw: string | null): boolean {
  return raw === "1";
}

let memory: boolean | null = null;
const listeners = new Set<() => void>();

export function getDetailOpen(): boolean {
  if (memory !== null) return memory;
  try {
    memory = parseDetailOpen(window.localStorage.getItem(DETAIL_OPEN_KEY));
  } catch {
    memory = false;
  }
  return memory;
}

export function getServerDetailOpen(): boolean {
  return false;
}

export function setDetailOpen(value: boolean): void {
  if (value === memory) return;
  memory = value;
  try {
    window.localStorage.setItem(DETAIL_OPEN_KEY, value ? "1" : "0");
  } catch {
    // 覚えられなくても、この頁を開いている間は開閉できる
  }
  for (const l of listeners) l();
}

export function subscribeDetailOpen(listener: () => void): () => void {
  listeners.add(listener);
  // 別のタブで開閉したとき
  const onStorage = (e: StorageEvent) => {
    if (e.key !== DETAIL_OPEN_KEY && e.key !== null) return;
    memory = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
