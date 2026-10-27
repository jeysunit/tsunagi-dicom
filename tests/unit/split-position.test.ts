import { describe, expect, it } from "vitest";
import { SPLIT_MIN_BODY_REM } from "@/lib/client/narrow";
import { clampSplit, parseSplit, SPLIT_DEFAULT, SPLIT_KEY, SPLIT_MAX, SPLIT_MIN, splitAfterKey } from "@/lib/client/split-position";

// 左（一覧）と右（詳細）の境目の位置：一覧の幅の百分率（docs/spec.md の 3.1）

describe("境目の位置", () => {
  it("範囲に収める", () => {
    expect(clampSplit(5)).toBe(SPLIT_MIN);
    expect(clampSplit(99)).toBe(SPLIT_MAX);
    expect(clampSplit(41.6)).toBe(42);
    expect(clampSplit(Number.NaN)).toBe(SPLIT_DEFAULT);
  });

  it("覚えた値が読めない・範囲の外なら既定", () => {
    expect(parseSplit(null)).toBe(SPLIT_DEFAULT);
    expect(parseSplit("")).toBe(SPLIT_DEFAULT);
    expect(parseSplit("abc")).toBe(SPLIT_DEFAULT);
    expect(parseSplit("5")).toBe(SPLIT_DEFAULT);
    expect(parseSplit("1000")).toBe(SPLIT_DEFAULT);
    expect(parseSplit("60")).toBe(60);
  });

  it("矢印の左右・Home・End で動き、端で止まる。上下と、ほかのキーは扱わない", () => {
    expect(splitAfterKey(45, "ArrowRight")).toBe(50);
    expect(splitAfterKey(45, "ArrowLeft")).toBe(40);
    expect(splitAfterKey(SPLIT_DEFAULT, "ArrowRight")).toBe(SPLIT_DEFAULT + 5);
    expect(splitAfterKey(SPLIT_MIN, "ArrowLeft")).toBe(SPLIT_MIN);
    expect(splitAfterKey(SPLIT_MAX, "ArrowRight")).toBe(SPLIT_MAX);
    expect(splitAfterKey(45, "Home")).toBe(SPLIT_MIN);
    expect(splitAfterKey(45, "End")).toBe(SPLIT_MAX);
    expect(splitAfterKey(45, "ArrowUp")).toBeNull();
    expect(splitAfterKey(45, "ArrowDown")).toBeNull();
    expect(splitAfterKey(45, "a")).toBeNull();
  });

  it("既定は 一覧 45：詳細 55。左右に分けるのは本文が 852px（一覧 440・境目 12・詳細 400）以上のとき", () => {
    expect(SPLIT_DEFAULT).toBe(45);
    expect(SPLIT_MIN_BODY_REM * 16).toBe(440 + 12 + 400);
  });

  it("上下に分けていたときの覚えとは別の鍵に持つ（古い値を幅として読まない）", () => {
    expect(SPLIT_KEY).not.toBe("tsunagi-dicom.listSplit");
  });
});
