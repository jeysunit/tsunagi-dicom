import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, pickRow, selectAll, selectedIndexes } from "@/lib/client/row-selection";

// 表の行の複数選択（クリック・Shift・Ctrl／Cmd）の位置の計算

const picked = (s: ReturnType<typeof pickRow>) => selectedIndexes(s);

describe("pickRow", () => {
  it("ふつうのクリックは、その 1 行だけを選び、ほかの選びを外す", () => {
    const first = pickRow(EMPTY_SELECTION, 2);
    expect(picked(first)).toEqual([2]);
    expect(first.anchor).toBe(2);
    expect(picked(pickRow(first, 5))).toEqual([5]);
  });

  it("Ctrl／Cmd のクリックは、その行を足し、もう一度押すと外す", () => {
    let s = pickRow(EMPTY_SELECTION, 1);
    s = pickRow(s, 4, { toggle: true });
    expect(picked(s)).toEqual([1, 4]);
    s = pickRow(s, 1, { toggle: true });
    expect(picked(s)).toEqual([4]);
    expect(s.anchor).toBe(1);
  });

  it("Shift のクリックは、基点から押した行までの範囲を選ぶ（上向きも）", () => {
    let s = pickRow(EMPTY_SELECTION, 2);
    s = pickRow(s, 5, { range: true });
    expect(picked(s)).toEqual([2, 3, 4, 5]);
    expect(s.anchor).toBe(2);
    s = pickRow(s, 0, { range: true });
    expect(picked(s)).toEqual([0, 1, 2]);
  });

  it("Shift のクリックは、Ctrl を押していなければ、範囲の外の選びを外す", () => {
    let s = pickRow(EMPTY_SELECTION, 0);
    s = pickRow(s, 7, { toggle: true });
    s = pickRow(s, 3, { range: true });
    // 基点は最後に Ctrl で選んだ 7
    expect(picked(s)).toEqual([3, 4, 5, 6, 7]);
  });

  it("Ctrl と Shift を一緒に押したクリックは、いまの選びに範囲を足す", () => {
    let s = pickRow(EMPTY_SELECTION, 0);
    s = pickRow(s, 6, { toggle: true });
    s = pickRow(s, 8, { toggle: true, range: true });
    expect(picked(s)).toEqual([0, 6, 7, 8]);
  });

  it("選びが空のときの Shift は、押した行だけを選ぶ", () => {
    expect(picked(pickRow(EMPTY_SELECTION, 3, { range: true }))).toEqual([3]);
  });

  it("元の選びを書き換えない", () => {
    const s = pickRow(EMPTY_SELECTION, 1);
    pickRow(s, 3, { toggle: true });
    expect(picked(s)).toEqual([1]);
  });
});

describe("selectAll", () => {
  it("先頭から全部の行を選ぶ", () => {
    expect(picked(selectAll(4))).toEqual([0, 1, 2, 3]);
  });
  it("行が無ければ空", () => {
    expect(picked(selectAll(0))).toEqual([]);
  });
});
