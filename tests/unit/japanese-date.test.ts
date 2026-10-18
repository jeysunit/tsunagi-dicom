import { describe, expect, it } from "vitest";
import {
  ageAt,
  formatBirthLine,
  formatDicomTime,
  formatSlashDate,
  parseDicomDate,
  sexLabel,
  toWareki,
} from "@/lib/format/japanese-date";

// 和暦・年齢・性別（docs/spec.md の 3.1）。

const d = (s: string) => parseDicomDate(s)!;

describe("和暦", () => {
  it.each([
    // 令和の改元（2019-05-01）
    ["20190430", "平成31年"],
    ["20190501", "令和元年"],
    ["20200101", "令和2年"],
    // 平成の改元（1989-01-08）
    ["19890107", "昭和64年"],
    ["19890108", "平成元年"],
    // 昭和の改元（1926-12-25）
    ["19261224", "大正15年"],
    ["19261225", "昭和元年"],
    ["19750510", "昭和50年"],
    // 大正・明治
    ["19120729", "明治45年"],
    ["19120730", "大正元年"],
    ["18681023", "明治元年"],
  ])("%s は %s", (date, expected) => {
    expect(toWareki(d(date))).toBe(expected);
  });

  it("明治より前は空", () => {
    expect(toWareki(d("18681022"))).toBe("");
  });
});

describe("年齢（検査日の時点）", () => {
  it("誕生日の前日までは前の歳、当日から次の歳", () => {
    expect(ageAt(d("19750510"), d("20260509"))).toBe(50);
    expect(ageAt(d("19750510"), d("20260510"))).toBe(51);
    expect(ageAt(d("19750510"), d("20261017"))).toBe(51);
  });

  it("2月29日生まれは、平年は3月1日に歳を取る", () => {
    expect(ageAt(d("20000229"), d("20210228"))).toBe(20);
    expect(ageAt(d("20000229"), d("20210301"))).toBe(21);
    expect(ageAt(d("20000229"), d("20240229"))).toBe(24);
  });

  it("生まれた日は0歳、生まれる前は null", () => {
    expect(ageAt(d("20200301"), d("20200301"))).toBe(0);
    expect(ageAt(d("20200301"), d("20200229"))).toBeNull();
  });
});

describe("生年月日の1行", () => {
  it("spec の形：1975/05/10（昭和50年・51歳・男）", () => {
    expect(formatBirthLine("19750510", "M", "20261017")).toBe("1975/05/10（昭和50年・51歳・男）");
  });

  it("令和・平成の生まれ", () => {
    expect(formatBirthLine("20200301", "M", "20261017")).toBe("2020/03/01（令和2年・6歳・男）");
    expect(formatBirthLine("19950101", "F", "20261017")).toBe("1995/01/01（平成7年・31歳・女）");
  });

  it("検査日が読めなければ年齢を出さない", () => {
    expect(formatBirthLine("19750510", "M", "")).toBe("1975/05/10（昭和50年・男）");
  });

  it("出せない部分は飛ばし、例外にしない", () => {
    expect(formatBirthLine("", "F", "20261017")).toBe("（女）");
    expect(formatBirthLine("", "", "")).toBe("");
    expect(formatBirthLine("19750230", "X", "20261017")).toBe("");
    expect(formatBirthLine(undefined, null, 3)).toBe("");
  });
});

describe("日付・時刻・性別の読み取り", () => {
  it("暦に無い日・形の違う値は読まない", () => {
    expect(parseDicomDate("20230229")).toBeNull();
    expect(parseDicomDate("20240229")).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseDicomDate("2026131")).toBeNull();
    expect(parseDicomDate("20261301")).toBeNull();
    expect(parseDicomDate("1975.05.10")).toEqual({ year: 1975, month: 5, day: 10 });
    expect(formatSlashDate("x")).toBe("");
  });

  it("時刻は時と分だけ", () => {
    expect(formatDicomTime("093000")).toBe("09:30");
    expect(formatDicomTime("0930")).toBe("09:30");
    expect(formatDicomTime("09:30:00")).toBe("09:30");
    expect(formatDicomTime("2561")).toBe("");
    expect(formatDicomTime("")).toBe("");
  });

  it("性別", () => {
    expect([sexLabel("M"), sexLabel("F"), sexLabel("O"), sexLabel("m "), sexLabel(""), sexLabel("U")]).toEqual([
      "男",
      "女",
      "その他",
      "男",
      "",
      "",
    ]);
  });
});
