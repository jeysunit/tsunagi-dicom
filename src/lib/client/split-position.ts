// 検査の一覧の、上（一覧）と下（詳細）の境目の位置。上の高さを、分ける場所の高さの百分率で持つ。
// 位置はブラウザの localStorage に覚える（利用者ごと＝この端末のこのブラウザごと。サーバーの利用者の設定には持たない：
// 画面の幅や高さに依る好みで、アカウントを越えて持ち回る値ではないため）。読めない・書けないときは、頁を開いている間だけ覚える。

export const SPLIT_KEY = "tsunagi-dicom.listSplit";
export const SPLIT_MIN = 20;
export const SPLIT_MAX = 80;
export const SPLIT_DEFAULT = 60;
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
    case "ArrowUp":
      return clampSplit(current - SPLIT_STEP);
    case "ArrowDown":
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
