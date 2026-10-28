import { describe, expect, it } from "vitest";
import { readBuildInfo } from "@/lib/build-info";

// 「バージョン情報」の頁の値（docs/spec.md の 2.3）：版は package.json、ビルドの commit は BUILD_COMMIT（16 進の 7〜40 文字だけ）。

describe("ビルドの情報", () => {
  it("版は package.json の値で、BUILD_COMMIT が無ければ commit は出さない", () => {
    const info = readBuildInfo({});
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(info.commit).toBeUndefined();
  });

  it("BUILD_COMMIT が 16 進の 7〜40 文字なら、小文字にして出す", () => {
    expect(readBuildInfo({ BUILD_COMMIT: " D986FD7 " }).commit).toBe("d986fd7");
    expect(readBuildInfo({ BUILD_COMMIT: "a".repeat(40) }).commit).toBe("a".repeat(40));
  });

  it("形が違う値は出さない（空・短すぎる・長すぎる・16 進でない）", () => {
    for (const bad of ["", "abc123", "a".repeat(41), "zzzzzzz", "d986fd7; rm"]) {
      expect(readBuildInfo({ BUILD_COMMIT: bad }).commit).toBeUndefined();
    }
  });
});
