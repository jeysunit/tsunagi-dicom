// 受信一覧の「新着」の印（docs/spec.md の 3.3。2026-10-21）。前にこの頁を開いたとき（このブラウザ）より後に受信した検査に付ける。
// 前に見た受信日時は、ブラウザの localStorage に覚える（境目の位置と同じ：この端末のこのブラウザごと。サーバーの利用者の設定には持たない。
// 読めない・書けないときは、新着の印を出さない）。

export const RECEIVED_SEEN_KEY = "tsunagi-dicom.receivedSeen";

/** 受信日時（ISO 8601）を数にする。読めなければ null */
function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** 新着か：前に見た受信日時より後に受信した。前に見た日時が無い（初めて開いた・読めない）ときは、どれも新着にしない */
export function isNewArrival(receivedAt: string | null | undefined, previous: string | null): boolean {
  const at = timeOf(receivedAt);
  const seen = timeOf(previous);
  return at !== null && seen !== null && at > seen;
}

/** いちばん新しい受信日時（次に開いたときの基準）。無ければ null */
export function latestReceivedAt(values: readonly (string | null | undefined)[]): string | null {
  let best: { value: string; at: number } | null = null;
  for (const v of values) {
    const at = timeOf(v);
    if (at !== null && (!best || at > best.at)) best = { value: v!, at };
  }
  return best?.value ?? null;
}

/**
 * 頁を開いたときに読んだ「前に見た受信日時」。頁を開いている間は替えない（再読み込みで新しい検査が届いても、
 * 前に開いた後のものに印を付け続ける）。頁を離れたら forgetPreviousSeen で忘れ、次に開いたときに読み直す
 */
let previous: string | null | undefined;

export function getPreviousSeen(): string | null {
  if (previous === undefined) {
    try {
      previous = window.localStorage.getItem(RECEIVED_SEEN_KEY);
    } catch {
      previous = null;
    }
  }
  return previous;
}

export function getServerPreviousSeen(): string | null {
  return null;
}

/** 見た受信日時を覚える（次に開いたときの基準。古い値で上書きしない） */
export function rememberSeen(latest: string | null): void {
  if (!latest) return;
  try {
    const stored = window.localStorage.getItem(RECEIVED_SEEN_KEY);
    if (stored && !isNewArrival(latest, stored)) return;
    window.localStorage.setItem(RECEIVED_SEEN_KEY, latest);
  } catch {
    // 覚えられなくても一覧は使える（新着の印が出ないだけ）
  }
}

export function forgetPreviousSeen(): void {
  previous = undefined;
}

/** useSyncExternalStore の購読（値は頁を開いている間は変わらないので、知らせることは無い） */
export function subscribePreviousSeen(): () => void {
  return () => {};
}
