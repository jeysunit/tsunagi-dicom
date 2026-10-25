import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePatientName, parsePatientNameForSearch, toFullWidthKana } from "@/lib/format/patient-name";

// 氏名の解析（docs/spec.md の 3.1）。tests/fixtures/patient-names.json の全部の形が通ること（AGENTS.md の試験の線）。

interface Case {
  id: string;
  input: string;
  name: string;
  kana: string;
  /** 検索にだけ使う値（第3〜5成分まで含める）が表示の値と違う形だけ */
  search?: { name: string; kana: string; alphabetic: string };
  note: string;
}

const fixture = JSON.parse(readFileSync("tests/fixtures/patient-names.json", "utf8")) as { cases: Case[] };
const doc = readFileSync("docs/patient-name-test-cases.md", "utf8");

describe("氏名の解析（tests/fixtures/patient-names.json）", () => {
  it("見本は 30 の形", () => {
    expect(fixture.cases).toHaveLength(30);
    expect(new Set(fixture.cases.map((c) => c.id)).size).toBe(30);
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const parsed = parsePatientName(c.input);
    expect({ name: parsed.name, kana: parsed.kana }).toEqual({ name: c.name, kana: c.kana });
    // 頭と末尾に空白を残さない
    expect(parsed.name).toBe(parsed.name.trim());
    expect(parsed.kana).toBe(parsed.kana.trim());
  });

  it.each(fixture.cases.map((c) => [c.id, c] as const))("%s の検索の氏名（表示の値は変えない）", (_id, c) => {
    const searched = parsePatientNameForSearch(c.input);
    const shown = parsePatientName(c.input);
    // search が無い形は、検索の値が表示の値と同じ
    expect({ name: searched.name, kana: searched.kana, alphabetic: searched.alphabetic }).toEqual(
      c.search ?? { name: shown.name, kana: shown.kana, alphabetic: shown.alphabetic },
    );
    // 表示の期待は、検索の値を足しても変わらない
    expect({ name: shown.name, kana: shown.kana }).toEqual({ name: c.name, kana: c.kana });
  });

  it("文書の「検索の氏名」の表と JSON の search が同じ中身", () => {
    const section = doc.slice(doc.indexOf("## 検索の氏名"));
    const withSearch = fixture.cases.filter((c) => c.search);
    expect(withSearch.length).toBeGreaterThan(0);
    const empty = (v: string) => (v === "" ? '`""`' : v);
    for (const c of withSearch) {
      const row = section.split("\n").find((line) => line.startsWith(`| ${c.id} |`));
      expect(row, c.id).toBeDefined();
      const cells = row!.split("|").map((s) => s.trim());
      // | ID | 入力 | 漢字 | かな | ローマ字 |
      expect(cells[2], `${c.id} の入力`).toBe(`\`${JSON.stringify(c.input)}\``);
      expect(cells[3], `${c.id} の検索の漢字`).toBe(empty(c.search!.name));
      expect(cells[4], `${c.id} の検索のかな`).toBe(empty(c.search!.kana));
      expect(cells[5], `${c.id} の検索のローマ字`).toBe(empty(c.search!.alphabetic));
    }
    // 表の行数も同じ（JSON に無い形を文書だけに載せない）
    expect(section.split("\n").filter((line) => /^\| PN-\d+ \|/.test(line))).toHaveLength(withSearch.length);
  });

  it("文書の一覧と JSON が同じ中身（ID・入力・期待）", () => {
    for (const c of fixture.cases) {
      const row = doc.split("\n").find((line) => line.startsWith(`| ${c.id} |`));
      expect(row, c.id).toBeDefined();
      const cells = row!.split("|").map((s) => s.trim());
      // | ID | 入力 | 漢字 | かな | 備考 |
      expect(cells[2], `${c.id} の入力`).toBe(`\`${JSON.stringify(c.input)}\``);
      expect(cells[3], `${c.id} の漢字`).toBe(c.name === "" ? '`""`' : c.name);
      expect(cells[4], `${c.id} のかな`).toBe(c.kana === "" ? '`""`' : c.kana);
    }
  });
});

describe("氏名の解析の細部", () => {
  it("ローマ字の組を、検索のために別に返す", () => {
    expect(parsePatientName("Yamada^Taro=山田^太郎=やまだ^たろう").alphabetic).toBe("Yamada Taro");
    expect(parsePatientName("==やまだ^たろう").alphabetic).toBe("");
  });

  it("文字列でない入力でも例外にしない", () => {
    for (const input of [undefined, null, 1, {}, []]) {
      expect(parsePatientName(input)).toEqual({ name: "", kana: "", alphabetic: "" });
    }
  });

  it("検索の氏名：第3〜5成分（ミドル・接頭・接尾）まで含める（PS3.5 6.2 の例）", () => {
    const s = parsePatientNameForSearch("Adams^John Robert Quincy^^Rev.^B.A. M.Div.");
    expect(s).toEqual({
      name: "Adams John Robert Quincy Rev. B.A. M.Div.",
      kana: "",
      alphabetic: "Adams John Robert Quincy Rev. B.A. M.Div.",
    });
    // 表示は姓と名のまま
    expect(parsePatientName("Adams^John Robert Quincy^^Rev.^B.A. M.Div.").name).toBe("Adams John Robert Quincy");
  });

  it("検索の氏名：表示が空になる組は、第3成分以降だけでも空のまま。6つ目以降の成分は使わない", () => {
    expect(parsePatientNameForSearch("^^Michael")).toEqual({ name: "", kana: "", alphabetic: "" });
    expect(parsePatientNameForSearch("==^^みちる")).toEqual({ name: "", kana: "", alphabetic: "" });
    expect(parsePatientNameForSearch("A^B^C^D^E^F").alphabetic).toBe("A B C D E");
  });

  it("検索の氏名：文字列でない入力でも例外にしない", () => {
    for (const input of [undefined, null, 1, {}, []]) {
      expect(parsePatientNameForSearch(input)).toEqual({ name: "", kana: "", alphabetic: "" });
    }
  });

  it("半角カナだけを全角にし、濁点・半濁点を1字にまとめる", () => {
    expect(toFullWidthKana("ｶﾞｸﾞﾊﾟﾎﾟ")).toBe("ガグパポ");
    // 前の字とまとまらない濁点は単独の字にする
    expect(toFullWidthKana("ﾞ")).toBe("゛");
    expect(toFullWidthKana("ｱﾞ")).toBe("ア゛");
    // 英数字（全角も）・ひらがな・異体字は変えない
    expect(toFullWidthKana("ＡＢ12やまだ髙")).toBe("ＡＢ12やまだ髙");
  });
});
