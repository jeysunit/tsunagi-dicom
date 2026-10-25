import { describe, expect, it } from "vitest";
import { instanceFromDicomJson, type DicomJsonDataset } from "@/lib/backend/dicom-json";

// 画像の一覧のスライス位置（SliceLocation (0020,1041)）：画像サーバーが返し、値が数のときだけ数にする（docs/spec.md の 3.1）。

const row = (slice?: unknown): DicomJsonDataset => ({
  "0020000D": { vr: "UI", Value: ["1.2.3"] },
  "0020000E": { vr: "UI", Value: ["4.5.6"] },
  "00080018": { vr: "UI", Value: ["7.8.9"] },
  "00200013": { vr: "IS", Value: [1] },
  ...(slice === undefined ? {} : { "00201041": { vr: "DS", Value: slice === null ? [] : [slice] } }),
});

describe("画像の一覧のスライス位置", () => {
  it("DS の文字列の数（符号・小数・指数）と、数の値を数にする", () => {
    expect(instanceFromDicomJson(row("12.50")).sliceLocation).toBe(12.5);
    expect(instanceFromDicomJson(row("-55.0000")).sliceLocation).toBe(-55);
    expect(instanceFromDicomJson(row("+3")).sliceLocation).toBe(3);
    expect(instanceFromDicomJson(row("1.5E1")).sliceLocation).toBe(15);
    expect(instanceFromDicomJson(row(-7.25)).sliceLocation).toBe(-7.25);
    expect(instanceFromDicomJson(row("0")).sliceLocation).toBe(0);
  });

  it("返さない・空・数でない値は null（番号だけを出す）", () => {
    expect(instanceFromDicomJson(row()).sliceLocation).toBeNull();
    expect(instanceFromDicomJson(row(null)).sliceLocation).toBeNull();
    // 空の文字列を 0 と読まない
    expect(instanceFromDicomJson(row("")).sliceLocation).toBeNull();
    expect(instanceFromDicomJson(row("  ")).sliceLocation).toBeNull();
    expect(instanceFromDicomJson(row("abc")).sliceLocation).toBeNull();
    expect(instanceFromDicomJson(row("12 mm")).sliceLocation).toBeNull();
    expect(instanceFromDicomJson(row("Infinity")).sliceLocation).toBeNull();
    expect(instanceFromDicomJson(row("0x10")).sliceLocation).toBeNull();
  });
});
