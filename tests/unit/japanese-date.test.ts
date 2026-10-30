import { describe, expect, it } from "vitest";
import {
  ageAt,
  birthParts,
  eraYear,
  formatBirthCell,
  formatBirthLine,
  formatDateTimeIn,
  formatDicomTime,
  formatSlashDate,
  parseDicomDate,
  sexLabel,
} from "@/lib/format/japanese-date";

// 和暦・年齢・性別（docs/spec.md の 3.1）。

const d = (s: string) => parseDicomDate(s)!;

// 部品集の変換の組（12 行）。生年月日 → 漢字 1 字の形・英字 1 字の形（元号なしは空）
const CONVERSIONS = [
  ["18681022", "", ""],
  ["18681023", "明1", "M1"],
  ["19120729", "明45", "M45"],
  ["19120730", "大1", "T1"],
  ["19261224", "大15", "T15"],
  ["19261225", "昭1", "S1"],
  ["19750514", "昭50", "S50"],
  ["19890107", "昭64", "S64"],
  ["19890108", "平1", "H1"],
  ["20190430", "平31", "H31"],
  ["20190501", "令1", "R1"],
  ["20261029", "令8", "R8"],
] as const;

describe("元号と年（短い表示）", () => {
  it.each(CONVERSIONS)("%s は 漢字 %s・英字 %s", (date, kanji, letter) => {
    expect(eraYear(d(date))).toBe(kanji);
    expect(eraYear(d(date), { letter: true })).toBe(letter);
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

// 部品集の年齢の境目の組（7 行）。生年月日 → 基準日 → 年齢
const AGE_EDGES = [
  ["19750514", "20260513", 50],
  ["19750514", "20260514", 51],
  ["20261029", "20261029", 0],
  ["20000229", "20260228", 25],
  ["20000229", "20260301", 26],
  ["20000229", "20280228", 27],
  ["20000229", "20280229", 28],
] as const;

describe("年齢の境目", () => {
  it.each(AGE_EDGES)("%s を %s に数えると %i 歳", (birth, at, age) => {
    expect(ageAt(d(birth), d(at))).toBe(age);
    expect(formatBirthCell(birth, at)).toContain(`${age}歳`);
  });
});

describe("患者の帯の生年月日（漢字 1 字。全角の括弧）", () => {
  it.each(CONVERSIONS)("%s の帯の形", (date, kanji) => {
    const age = ageAt(d(date), d("20261029"));
    const day = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6)}`;
    expect(birthParts(date, "20261029")).toEqual({ date: day, note: `（${kanji ? `${kanji}・` : ""}${age}歳）` });
  });

  it("spec の形：1975/05/14（昭50・51歳）男", () => {
    expect(formatBirthLine("19750514", "M", "20261017")).toBe("1975/05/14（昭50・51歳）男");
    expect(formatBirthLine("20200301", "M", "20261017")).toBe("2020/03/01（令2・6歳）男");
    expect(formatBirthLine("19950101", "F", "20261017")).toBe("1995/01/01（平7・31歳）女");
  });

  it("年齢は検査日の時点で数える（今日では数えない）", () => {
    expect(formatBirthLine("19750510", "", "20250509")).toBe("1975/05/10（昭50・49歳）");
    expect(formatBirthLine("19750510", "", "20260410")).toBe("1975/05/10（昭50・50歳）");
    expect(formatBirthLine("19750510", "", "20260510")).toBe("1975/05/10（昭50・51歳）");
  });

  it("明治より前は元号を出さず、年齢だけを括弧に入れる", () => {
    expect(formatBirthLine("18681022", "", "20261029")).toBe("1868/10/22（158歳）");
  });

  it("検査日が読めなければ年齢を出さない。生まれる前の検査日も出さない", () => {
    expect(formatBirthLine("19750510", "M", "")).toBe("1975/05/10（昭50）男");
    expect(formatBirthLine("20270101", "", "20261017")).toBe("2027/01/01（令9）");
  });

  it("出せない部分は飛ばし、例外にしない", () => {
    expect(formatBirthLine("", "F", "20261017")).toBe("女");
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

  it("TM の形（PS3.5 6.2）：時だけの値は分を「--」、小数の秒も読む。形の違う値は空", () => {
    expect(formatDicomTime("07")).toBe("07:--");
    expect(formatDicomTime("07 ")).toBe("07:--");
    expect(formatDicomTime("093000.123456")).toBe("09:30");
    expect(formatDicomTime("093000.1")).toBe("09:30");
    expect(formatDicomTime("24")).toBe("");
    expect(formatDicomTime("070")).toBe("");
    expect(formatDicomTime("0930001")).toBe("");
    expect(formatDicomTime("093000.1234567")).toBe("");
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

describe("一覧の表の生年月日の列（英字 1 字。半角の括弧）", () => {
  it.each(CONVERSIONS)("%s の列の形", (date, _kanji, letter) => {
    const age = ageAt(d(date), d("20261029"));
    const day = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6)}`;
    expect(formatBirthCell(date, "20261029")).toBe(`${day} (${letter ? `${letter}・` : ""}${age}歳)`);
  });

  it("例：1987/03/14 (S62・39歳)。年齢は行の検査日の時点", () => {
    expect(formatBirthCell("19870314", "20261017")).toBe("1987/03/14 (S62・39歳)");
    expect(formatBirthCell("19870314", "20260313")).toBe("1987/03/14 (S62・38歳)");
  });

  it("検査日が読めなければ年齢を出さない。生年月日が読めなければ空", () => {
    expect(formatBirthCell("19870314", "")).toBe("1987/03/14 (S62)");
    expect(formatBirthCell("x", "20261017")).toBe("");
  });
});

describe("画面の日時の書式（docs/spec.md の 2.2）", () => {
  it("UTC の時刻を TZ の時刻にし、時を0で埋める", () => {
    // Orthanc の変更の記録の時刻（UTC）。2026-10-20 に承認者が見た 21:00:23 は、日本時間の翌日 06:00:23
    expect(formatDateTimeIn("2026-10-19T21:00:23Z", "Asia/Tokyo", { seconds: true })).toBe("2026/10/20 06:00:23");
    expect(formatDateTimeIn("2026-10-19T20:49:00Z", "Asia/Tokyo")).toBe("2026/10/20 05:49");
    expect(formatDateTimeIn("2026-10-19T20:49:00Z", "UTC")).toBe("2026/10/19 20:49");
    expect(formatDateTimeIn("2026-10-19T15:00:00+00:00", "Asia/Tokyo")).toBe("2026/10/20 00:00");
  });

  it("時間帯の印の無い時刻と、読めない値は空（どの時間帯か分からない時刻を出さない）", () => {
    expect(formatDateTimeIn("2026-10-19T21:00:23", "Asia/Tokyo")).toBe("");
    expect(formatDateTimeIn("", "Asia/Tokyo")).toBe("");
    expect(formatDateTimeIn(undefined, "Asia/Tokyo")).toBe("");
    expect(formatDateTimeIn("2026-13-40T00:00:00Z", "Asia/Tokyo")).toBe("");
  });
});
