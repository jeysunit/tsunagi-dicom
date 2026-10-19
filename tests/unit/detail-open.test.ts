import { describe, expect, it } from "vitest";
import { parseDetailOpen } from "@/lib/client/detail-open";

describe("詳細の「すべての項目」の開閉の覚え", () => {
  it("開くのは 1 だけ。空・読めない値・無いときは閉じる（既定は閉じる）", () => {
    expect(parseDetailOpen("1")).toBe(true);
    expect(parseDetailOpen("0")).toBe(false);
    expect(parseDetailOpen("")).toBe(false);
    expect(parseDetailOpen("true")).toBe(false);
    expect(parseDetailOpen(null)).toBe(false);
  });
});
