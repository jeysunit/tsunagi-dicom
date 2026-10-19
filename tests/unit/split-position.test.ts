import { describe, expect, it } from "vitest";
import { clampSplit, parseSplit, SPLIT_DEFAULT, SPLIT_MAX, SPLIT_MIN, splitAfterKey } from "@/lib/client/split-position";

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
    expect(parseSplit("40")).toBe(40);
  });

  it("矢印の上下・Home・End で動き、端で止まる。ほかのキーは扱わない", () => {
    expect(splitAfterKey(55, "ArrowDown")).toBe(60);
    expect(splitAfterKey(55, "ArrowUp")).toBe(50);
    expect(splitAfterKey(SPLIT_MIN, "ArrowUp")).toBe(SPLIT_MIN);
    expect(splitAfterKey(SPLIT_MAX, "ArrowDown")).toBe(SPLIT_MAX);
    expect(splitAfterKey(55, "Home")).toBe(SPLIT_MIN);
    expect(splitAfterKey(55, "End")).toBe(SPLIT_MAX);
    expect(splitAfterKey(55, "a")).toBeNull();
  });
});
