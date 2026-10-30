import { describe, expect, it } from "vitest";
import {
  ageAt,
  BIRTH_FORMAT_ERROR,
  BIRTH_FUTURE_ERROR,
  birthInputHint,
  birthParts,
  eraYear,
  formatBirthCell,
  formatBirthLine,
  formatDateTimeIn,
  formatDicomTime,
  formatSlashDate,
  localToday,
  parseBirthInput,
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

// 生年月日の入力の読み取り（docs/spec.md の 3.1「生年月日の入力」）。3 製品で同じ組。開いた日（今日）を 2026/10/29 とし、
// 年齢も開いた日で数える
const OPENED = { year: 2026, month: 10, day: 29 };
const SAME_1975 = "1975/05/14（昭50・51歳）";
const SAME_1989 = "1989/01/08（平1・37歳）";
const SAME_2019 = "2019/05/01（令1・7歳）";
const SAME_2000 = "2000/02/29（平12・26歳）";
const BIRTH_ACCEPTED = [
  ["1975/05/14", "19750514", SAME_1975],
  ["1975/5/14", "19750514", SAME_1975],
  [" 1975/05/14 ", "19750514", SAME_1975],
  ["S50/05/14", "19750514", SAME_1975],
  ["s50/5/14", "19750514", SAME_1975],
  ["Ｓ50/05/14", "19750514", SAME_1975],
  ["昭50/05/14", "19750514", SAME_1975],
  ["昭和50年5月14日", "19750514", SAME_1975],
  ["H1/01/08", "19890108", SAME_1989],
  ["H元/01/08", "19890108", SAME_1989],
  ["平成元年1月8日", "19890108", SAME_1989],
  ["R1/05/01", "20190501", SAME_2019],
  ["令元/05/01", "20190501", SAME_2019],
  ["S64/01/07", "19890107", "1989/01/07（昭64・37歳）"],
  ["H31/04/30", "20190430", "2019/04/30（平31・7歳）"],
  ["M1/10/23", "18681023", "1868/10/23（明1・158歳）"],
  ["M45/07/29", "19120729", "1912/07/29（明45・114歳）"],
  ["T1/07/30", "19120730", "1912/07/30（大1・114歳）"],
  ["T15/12/24", "19261224", "1926/12/24（大15・99歳）"],
  ["S1/12/25", "19261225", "1926/12/25（昭1・99歳）"],
  ["1868/10/22", "18681022", "1868/10/22（158歳）"],
  ["2000/02/29", "20000229", SAME_2000],
  ["H12/02/29", "20000229", SAME_2000],
  ["2026/10/29", "20261029", "2026/10/29（令8・0歳）"],
] as const;

const SHOWA_AFTER = "生年月日が昭和の範囲にありません。昭和は 1989/01/07 までです。平成1年は 1989/01/08 からです。";
const HEISEI_AFTER = "生年月日が平成の範囲にありません。平成は 2019/04/30 までです。令和1年は 2019/05/01 からです。";
const HEISEI_BEFORE = "生年月日が平成の範囲にありません。平成は 1989/01/08 からです。昭和64年は 1989/01/07 までです。";
const REIWA_BEFORE = "生年月日が令和の範囲にありません。令和は 2019/05/01 からです。平成31年は 2019/04/30 までです。";
const MEIJI_BEFORE = "生年月日が明治の範囲にありません。明治は 1868/10/23 からです。";
const BIRTH_REFUSED = [
  ["1975-05-14", BIRTH_FORMAT_ERROR],
  ["19750514", BIRTH_FORMAT_ERROR],
  ["s50.5.14", BIRTH_FORMAT_ERROR],
  ["S500514", BIRTH_FORMAT_ERROR],
  ["75/05/14", BIRTH_FORMAT_ERROR],
  ["1975/S50/05/14", BIRTH_FORMAT_ERROR],
  ["S0/01/01", BIRTH_FORMAT_ERROR],
  ["1975/13/01", BIRTH_FORMAT_ERROR],
  ["1975/02/30", BIRTH_FORMAT_ERROR],
  ["2001/02/29", BIRTH_FORMAT_ERROR],
  ["X50/01/01", BIRTH_FORMAT_ERROR],
  ["S64/01/08", SHOWA_AFTER],
  ["S65/01/01", SHOWA_AFTER],
  ["H31/05/01", HEISEI_AFTER],
  ["H1/01/07", HEISEI_BEFORE],
  ["R1/04/30", REIWA_BEFORE],
  ["M1/10/22", MEIJI_BEFORE],
  ["2026/10/30", BIRTH_FUTURE_ERROR],
  ["R8/10/30", BIRTH_FUTURE_ERROR],
] as const;

describe("生年月日の入力の読み取り（受ける形）", () => {
  it.each(BIRTH_ACCEPTED)("%s は %s・%s", (input, da, hint) => {
    const read = parseBirthInput(input, OPENED);
    expect(read).toMatchObject({ ok: true, da });
    if (!read.ok) return;
    expect(birthInputHint(read.date, OPENED)).toBe(hint);
  });
});

describe("生年月日の入力の読み取り（誤り）", () => {
  it.each(BIRTH_REFUSED)("%s は断る", (input, message) => {
    expect(parseBirthInput(input, OPENED)).toEqual({ ok: false, message });
  });

  it("誤りの文は決めた文のまま", () => {
    expect(BIRTH_FORMAT_ERROR).toBe("生年月日を読み取れません。1975/05/14 か S50/05/14 の形で入力してください。");
    expect(BIRTH_FUTURE_ERROR).toBe("生年月日が今日より後です。日付を確かめてください。");
  });

  it("元号の終わりより後・始まりより前の文は、元号の正式名と範囲を入れる（大正・明治の例）", () => {
    expect(parseBirthInput("大16/01/01", OPENED)).toEqual({
      ok: false,
      message: "生年月日が大正の範囲にありません。大正は 1926/12/24 までです。昭和1年は 1926/12/25 からです。",
    });
    expect(parseBirthInput("明治46年1月1日", OPENED)).toEqual({
      ok: false,
      message: "生年月日が明治の範囲にありません。明治は 1912/07/29 までです。大正1年は 1912/07/30 からです。",
    });
    expect(parseBirthInput("T1/07/29", OPENED)).toEqual({
      ok: false,
      message: "生年月日が大正の範囲にありません。大正は 1912/07/30 からです。明治45年は 1912/07/29 までです。",
    });
    expect(parseBirthInput("S1/12/24", OPENED)).toEqual({
      ok: false,
      message: "生年月日が昭和の範囲にありません。昭和は 1926/12/25 からです。大正15年は 1926/12/24 までです。",
    });
  });

  it("全角の数字・全角の「／」・空・年が 0 の西暦は形が合わない", () => {
    for (const input of ["１９７５/05/14", "1975／05／14", "S５０/05/14", "", "   ", "0000/01/01"]) {
      expect(parseBirthInput(input, OPENED), input).toEqual({ ok: false, message: BIRTH_FORMAT_ERROR });
    }
  });

  it("確かめる順は 形 → 元号の範囲 → 今日より後（範囲の外で今日より後なら、範囲の誤り）", () => {
    expect(parseBirthInput("H40/01/01", OPENED)).toMatchObject({ ok: false, message: HEISEI_AFTER });
    expect(parseBirthInput("R8/02/30", OPENED)).toEqual({ ok: false, message: BIRTH_FORMAT_ERROR });
  });
});

describe("読み取り結果の年齢を数える日", () => {
  const birth = { year: 1975, month: 5, day: 10 };
  it.each([
    [{ year: 2026, month: 4, day: 10 }, "1975/05/10（昭50・50歳）"],
    [{ year: 2026, month: 5, day: 10 }, "1975/05/10（昭50・51歳）"],
    [{ year: 2025, month: 5, day: 9 }, "1975/05/10（昭50・49歳）"],
    [OPENED, "1975/05/10（昭50・51歳）"],
  ])("%o の時点", (at, hint) => {
    expect(birthInputHint(birth, at)).toBe(hint);
  });

  it("数える日より後の生年月日は年齢を出さない", () => {
    expect(birthInputHint({ year: 2026, month: 12, day: 1 }, OPENED)).toBe("2026/12/01（令8）");
  });

  it("明治より前は元号なし", () => {
    expect(birthInputHint({ year: 1860, month: 3, day: 3 }, OPENED)).toBe("1860/03/03（166歳）");
  });

  it("画面の今日は端末の時間帯の日付", () => {
    expect(localToday(new Date(2026, 9, 29, 23, 59))).toEqual(OPENED);
  });
});
