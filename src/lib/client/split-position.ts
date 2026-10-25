// 検査の一覧の、左（一覧）と右（詳細）の境目の位置。一覧の幅を、分ける場所の幅の百分率で持つ（docs/spec.md の 3.1）。
// 位置はブラウザの localStorage に覚える（利用者ごと＝この端末のこのブラウザごと。サーバーの利用者の設定には持たない：
// 画面の幅や高さに依る好みで、アカウントを越えて持ち回る値ではないため）。読めない・書けないときは、頁を開いている間だけ覚える。
// 上下に分けていたとき（一覧の高さの百分率）の覚えとは別の鍵にする（古い値を幅の百分率として読まないため）。

export const SPLIT_KEY = "tsunagi-dicom.listWidth";
export const SPLIT_MIN = 30;
export const SPLIT_MAX = 75;
export const SPLIT_DEFAULT = 55;
export const SPLIT_STEP = 5;

export function clampSplit(value: number): number {
  if (!Number.isFinite(value)) return SPLIT_DEFAULT;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Math.round(value)));
}

/** 覚えた文字列を位置にする。読めない・範囲の外は既定 */
export function parseSplit(raw: string | null): number {
  if (raw === null || raw.trim() === "") return SPLIT_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < SPLIT_MIN || n > SPLIT_MAX) return SPLIT_DEFAULT;
  return Math.round(n);
}

/** 境目に付けた矢印などのキーで動かした後の位置。対象外のキーは null */
export function splitAfterKey(current: number, key: string): number | null {
  switch (key) {
    case "ArrowLeft":
      return clampSplit(current - SPLIT_STEP);
    case "ArrowRight":
      return clampSplit(current + SPLIT_STEP);
    case "Home":
      return SPLIT_MIN;
    case "End":
      return SPLIT_MAX;
    default:
      return null;
  }
}

// useSyncExternalStore 用の入れ物（サーバーの描画は既定の位置。ブラウザでは覚えた位置を、描く前に読む）
let memory: number | null = null;
const listeners = new Set<() => void>();

export function getSplit(): number {
  if (memory !== null) return memory;
  try {
    memory = parseSplit(window.localStorage.getItem(SPLIT_KEY));
  } catch {
    memory = SPLIT_DEFAULT;
  }
  return memory;
}

export function getServerSplit(): number {
  return SPLIT_DEFAULT;
}

export function setSplit(value: number): void {
  const next = clampSplit(value);
  if (next === memory) return;
  memory = next;
  try {
    window.localStorage.setItem(SPLIT_KEY, String(next));
  } catch {
    // 覚えられなくても、この頁を開いている間は動かせる
  }
  for (const l of listeners) l();
}

export function subscribeSplit(listener: () => void): () => void {
  listeners.add(listener);
  // 別のタブで動かしたとき
  const onStorage = (e: StorageEvent) => {
    if (e.key !== SPLIT_KEY && e.key !== null) return;
    memory = null;
    listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}
