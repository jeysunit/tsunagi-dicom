import { describe, expect, it } from "vitest";
import { pinTagRow, tagRowsText, tagRowText } from "@/lib/client/tag-copy";

// DICOM タグの表で選んだ行を写す文字（1 行 1 タグ。タグ・タグ名・VR・値をタブで区切る）

describe("tagRowText", () => {
  it("タグを括弧で囲み、タグ名・VR・値をタブで区切る", () => {
    expect(tagRowText({ tag: "0008,0020", name: "検査日", vr: "DA", value: "20261024" })).toBe("(0008,0020)\t検査日\tDA\t20261024");
  });

  it("タグ名が無いタグも、列の数を保つ", () => {
    expect(tagRowText({ tag: "0009,0010", vr: "LO", value: "X" })).toBe("(0009,0010)\t\tLO\tX");
  });

  it("値が無いタグは、値を空にする", () => {
    expect(tagRowText({ tag: "0018,0050", name: "スライス厚", vr: "DS", value: null })).toBe("(0018,0050)\tスライス厚\tDS\t");
  });

  it("値の中のタブと改行は空白 1 つにして、行と列の区切りと混ぜない", () => {
    expect(tagRowText({ tag: "0020,4000", name: "画像コメント", vr: "LT", value: "a\tb\r\nc\nd" })).toBe("(0020,4000)\t画像コメント\tLT\ta b c d");
  });

  it("切って出した値は、表に見えているとおり全体の文字数を添えて写す", () => {
    expect(tagRowText({ tag: "0020,4000", name: "画像コメント", vr: "LT", value: "abc", length: 5000 })).toBe(
      "(0020,4000)\t画像コメント\tLT\tabc…（全 5000 文字）",
    );
  });

  it("多値の区切り（バックスラッシュ）はそのまま写す", () => {
    expect(tagRowText({ tag: "0008,0008", name: "画像タイプ", vr: "CS", value: "ORIGINAL\\PRIMARY" })).toBe(
      "(0008,0008)\t画像タイプ\tCS\tORIGINAL\\PRIMARY",
    );
  });
});

describe("写す形式", () => {
  const row = { tag: "0008,0020", name: "検査日", vr: "DA", value: "20261024" };
  it("タグと値：タグと値の 2 列", () => {
    expect(tagRowText(row, "tag-value")).toBe("(0008,0020)\t20261024");
  });
  it("値だけ：値の 1 列。値が無ければ空", () => {
    expect(tagRowText(row, "value")).toBe("20261024");
    expect(tagRowText({ ...row, value: null }, "value")).toBe("");
  });
  it("どの形式でも、切った値は全体の文字数を添え、バイナリの表示はそのまま写す", () => {
    expect(tagRowText({ ...row, value: "abc", length: 2000 }, "value")).toBe("abc…（全 2000 文字）");
    expect(tagRowText({ tag: "7FE0,0010", name: "画素データ", vr: "OW", value: "（バイナリ）" }, "tag-value")).toBe("(7FE0,0010)\t（バイナリ）");
  });
  it("複数の行も形式に従う", () => {
    expect(tagRowsText([row, { ...row, value: "20260101" }], "value")).toBe("20261024\n20260101");
  });
});

describe("tagRowsText", () => {
  it("複数の行は改行でつなぎ、末尾に改行を付けない", () => {
    const text = tagRowsText([
      { tag: "0008,0020", name: "検査日", vr: "DA", value: "20261024" },
      { tag: "0010,0020", name: "患者ID", vr: "LO", value: "JP-TEST-0001" },
    ]);
    expect(text).toBe("(0008,0020)\t検査日\tDA\t20261024\n(0010,0020)\t患者ID\tLO\tJP-TEST-0001");
  });

  it("行が無ければ空の文字", () => {
    expect(tagRowsText([])).toBe("");
  });
});

describe("pinTagRow", () => {
  const a = { tag: "0008,0020", vr: "DA", value: "1" };
  const b = { tag: "0008,0018", vr: "UI", value: "2" };
  const c = { tag: "0010,0020", vr: "LO", value: "3" };
  const fallback = { tag: "0008,0018", vr: "UI", value: "x" };

  it("表にある行を 1 行目に移し、ほかの行の順は変えない", () => {
    expect(pinTagRow([a, b, c], "0008,0018", fallback)).toEqual([b, a, c]);
  });

  it("すでに 1 行目なら、そのまま", () => {
    expect(pinTagRow([b, a, c], "0008,0018", fallback)).toEqual([b, a, c]);
  });

  it("表に無いときは、代わりの行を 1 行目に足す", () => {
    expect(pinTagRow([a, c], "0008,0018", fallback)).toEqual([fallback, a, c]);
  });
});
