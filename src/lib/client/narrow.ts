import { useEffect, useState, type RefObject } from "react";

// 検査の一覧を左右に分けるのに要る幅（px）：一覧の最小（320）＋境目（12）＋詳細の最小（400）。これより狭い本文では、左右に分けず、
// 詳細を一覧の上に重ねる（docs/spec.md の 3.1）。画面の幅ではなく、本文の幅で決める（左のナビを開くと、本文は 208px 狭くなる）。
// CSS の側は、同じ値（46rem）の container query で切り替える（study-browser.tsx）。
export const SPLIT_MIN_BODY_PX = 736;

/** 要素の幅が px より狭いか。サーバーの描画と最初の描画は false（広い）。幅が変わるたびに測り直す */
export function useNarrowerThan(ref: RefObject<HTMLElement | null>, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setNarrow(el.clientWidth < px);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, px]);
  return narrow;
}
