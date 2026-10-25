// 表の行の複数選択（クリック・Shift・Ctrl／Cmd・矢印のキー）。画面の部品から切り離した、位置だけの計算。
// 選んだ行は位置（0 始まり）の集合で持ち、基点（anchor）は Shift で範囲を取るときの起点。

export interface RowSelection {
  /** 選んだ行の位置 */
  selected: ReadonlySet<number>;
  /** Shift で範囲を取る起点。選びが空のときは null */
  anchor: number | null;
}

export const EMPTY_SELECTION: RowSelection = { selected: new Set(), anchor: null };

export interface PickModifiers {
  /** Shift：基点から押した行までの範囲を選ぶ（Ctrl／Cmd が無ければ、ほかの選びは外す） */
  range?: boolean;
  /** Ctrl（Mac は Cmd）：押した行だけを足す・外す */
  toggle?: boolean;
}

function span(from: number, to: number): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** 行 index を押した（または矢印のキーで動いた）ときの、次の選び */
export function pickRow(current: RowSelection, index: number, { range = false, toggle = false }: PickModifiers = {}): RowSelection {
  if (range) {
    const anchor = current.anchor ?? index;
    const picked = span(anchor, index);
    // Ctrl と Shift を同時に押したときは、いまの選びに範囲を足す（基点は変えない）
    const next = toggle ? new Set([...current.selected, ...picked]) : new Set(picked);
    return { selected: next, anchor };
  }
  if (toggle) {
    const next = new Set(current.selected);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    return { selected: next, anchor: index };
  }
  return { selected: new Set([index]), anchor: index };
}

/** 先頭から count 行すべてを選ぶ（Ctrl／Cmd + A）。行が無ければ空 */
export function selectAll(count: number, anchor: number | null = 0): RowSelection {
  if (count <= 0) return EMPTY_SELECTION;
  return { selected: new Set(Array.from({ length: count }, (_, i) => i)), anchor: anchor ?? 0 };
}

/** 選んだ位置を小さい順に */
export function selectedIndexes(selection: RowSelection): number[] {
  return [...selection.selected].sort((a, b) => a - b);
}
