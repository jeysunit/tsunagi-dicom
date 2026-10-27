import { useEffect, useState, type RefObject } from "react";

// 検査の一覧を左右に分けるのに要る幅（rem）：一覧の最小（27.5rem＝440px）＋境目（0.75rem＝12px）＋詳細の最小（25rem＝400px）＝ 852px。
// これより狭い本文では、左右に分けず、詳細を一覧の上に重ねる（docs/spec.md の 3.1）。画面の幅ではなく、本文の幅で決める（左のナビを開くと、本文は 208px 狭くなる）。
// CSS の側は、同じ値（53.25rem）の container query で切り替える（study-browser.tsx）。rem は利用者のブラウザの文字の大きさで px が替わるので、
// JS の側も rem で比べ、CSS と同じ幅で切り替わるようにする。
export const SPLIT_MIN_BODY_REM = 53.25;

/** 要素の幅が rem より狭いか。サーバーの描画と最初の描画は false（広い）。幅が変わるたびに測り直す */
export function useNarrowerThan(ref: RefObject<HTMLElement | null>, rem: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // container query の rem は、html 要素の文字の大きさ
      const root = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setNarrow(el.clientWidth < rem * root);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, rem]);
  return narrow;
}
