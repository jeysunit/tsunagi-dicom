import { describe, expect, it } from "vitest";
import { tagRowsText, tagRowText } from "@/lib/client/tag-copy";

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
