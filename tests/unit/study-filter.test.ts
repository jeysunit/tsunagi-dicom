import { describe, expect, it } from "vitest";
import type { StudyView } from "@/lib/fields";
import {
  dateQuery,
  filterToSearchParams,
  attachSearchNames,
  matchesFilter,
  normalizeForSearch,
  parseFilter,
  todayIn,
} from "@/lib/study-filter";

// 検査の一覧のすぐ絞れる見出し（docs/spec.md の 3.1）。

const TODAY = { year: 2026, month: 10, day: 19 };

describe("検査日の見出し", () => {
  it("今日・昨日・1週間（今日を含む7日）・今月・全期間", () => {
    expect(dateQuery({ date: "today" }, TODAY)).toEqual({ dateFrom: "20261019", dateTo: "20261019" });
    expect(dateQuery({ date: "yesterday" }, TODAY)).toEqual({ dateFrom: "20261018", dateTo: "20261018" });
    expect(dateQuery({ date: "week" }, TODAY)).toEqual({ dateFrom: "20261013", dateTo: "20261019" });
    expect(dateQuery({ date: "month" }, TODAY)).toEqual({ dateFrom: "20261001", dateTo: "20261019" });
    expect(dateQuery({ date: "all" }, TODAY)).toEqual({});
  });

  it("月・年の境目", () => {
    const newYear = { year: 2027, month: 1, day: 1 };
    expect(dateQuery({ date: "yesterday" }, newYear)).toEqual({ dateFrom: "20261231", dateTo: "20261231" });
    expect(dateQuery({ date: "week" }, newYear)).toEqual({ dateFrom: "20261226", dateTo: "20270101" });
    expect(dateQuery({ date: "yesterday" }, { year: 2024, month: 3, day: 1 })).toEqual({ dateFrom: "20240229", dateTo: "20240229" });
  });

  it("期間の指定（片方だけでもよい）", () => {
    expect(dateQuery({ date: "range", from: "2026-04-01", to: "2026-04-30" }, TODAY)).toEqual({ dateFrom: "20260401", dateTo: "20260430" });
    expect(dateQuery({ date: "range", from: "2026-04-01" }, TODAY)).toEqual({ dateFrom: "20260401" });
  });

  it("今日はサーバーの時間帯（TZ）で数える", () => {
    // 2026-10-18 15:30 UTC は、東京では 10-19 の 0:30
    const now = new Date("2026-10-18T15:30:00Z");
    expect(todayIn("Asia/Tokyo", now)).toEqual({ year: 2026, month: 10, day: 19 });
    expect(todayIn("UTC", now)).toEqual({ year: 2026, month: 10, day: 18 });
  });
});

describe("URL の値の読み取り", () => {
  it("読めない値は使わない", () => {
    expect(parseFilter(new URLSearchParams("date=forever&modality=XA&status=done&q=%20"))).toEqual({ date: "all" });
    expect(parseFilter(new URLSearchParams("date=range&from=2026-02-30&to=2026-03-01"))).toEqual({ date: "range", to: "2026-03-01" });
    // 期間の指定でなければ from・to は使わない
    expect(parseFilter(new URLSearchParams("date=today&from=2026-01-01"))).toEqual({ date: "today" });
  });

  it("横断の検索の語は前後の空白を落とし、長さを切る", () => {
    expect(parseFilter({ q: "  山田  " }).q).toBe("山田");
    expect(parseFilter({ q: "x".repeat(500) }).q).toHaveLength(100);
    expect(parseFilter({ q: ["a", "b"] }).q).toBe("a");
  });

  it("URL に戻す（既定の値は書かない）", () => {
    const f = parseFilter(new URLSearchParams("date=range&from=2026-04-01&modality=CR%2FDX&q=yamada"));
    expect(parseFilter(filterToSearchParams(f))).toEqual(f);
    expect(filterToSearchParams({ date: "all" }).toString()).toBe("");
  });
});

const row = (extra: Partial<StudyView> = {}): StudyView => ({
  studyInstanceUid: "1.2.3",
  patientId: "JP-TEST-0001",
  patientName: "山田 太郎",
  patientKana: "やまだ たろう",
  patientNameAlphabetic: "Yamada Taro",
  accessionNumber: "ACC-0001-1",
  studyDescription: "胸部CT",
  modalities: ["DX", "SR"],
  ...extra,
});

describe("モダリティ・横断の検索", () => {
  it("CR/DX の群は CR と DX の両方に合う", () => {
    expect(matchesFilter(row(), { date: "all", modality: "CR/DX" })).toBe(true);
    expect(matchesFilter(row({ modalities: ["CR"] }), { date: "all", modality: "CR/DX" })).toBe(true);
    expect(matchesFilter(row(), { date: "all", modality: "CT" })).toBe(false);
  });

  it("段 3：前の状態の見出しの値（status）は URL から読まない", () => {
    expect(parseFilter(new URLSearchParams("status=urgent"))).toEqual({ date: "all" });
    expect(filterToSearchParams(parseFilter(new URLSearchParams("status=bookmarked&modality=CT"))).toString()).toBe("modality=CT");
  });

  // 患者 ID・受付番号は全体の一致（全角半角・大文字小文字はそろえる）。氏名と検査の記述は含む
  it.each(["JP-TEST-0001", "ｊｐ-test-0001", "山田太郎", "山田 太郎", "やまだ", "ヤマダ", "ﾔﾏﾀﾞ", "yamada taro", "ACC-0001-1", "acc-0001-1", "胸部"])(
    "「%s」で探せる",
    (q) => {
      expect(matchesFilter(row(), { date: "all", q })).toBe(true);
    },
  );

  it("合わない語", () => {
    expect(matchesFilter(row(), { date: "all", q: "鈴木" })).toBe(false);
  });

  // 旧：「jp-test」「ACC-0001」で患者 ID・受付番号の一部に合った → 新：全体の一致だけ
  it.each(["jp-test", "0001", "JP-TEST-000", "ACC-0001", "0001-1"])("患者 ID・受付番号の一部（「%s」）には合わない", (q) => {
    expect(matchesFilter(row(), { date: "all", q })).toBe(false);
  });

  it("「025」で「1025」に合わない：患者 ID・受付番号は全体が一致するものだけ", () => {
    expect(matchesFilter(row({ patientId: "1025", accessionNumber: "A1025" }), { date: "all", q: "025" })).toBe(false);
    expect(matchesFilter(row({ patientId: "025" }), { date: "all", q: "025" })).toBe(true);
    expect(matchesFilter(row({ accessionNumber: "025" }), { date: "all", q: "025" })).toBe(true);
    // 前後・途中の空白はそろえる
    expect(matchesFilter(row({ patientId: "025" }), { date: "all", q: " 0 25 " })).toBe(true);
  });

  it("氏名と検査の記述は含むかで探す（患者 ID・受付番号と同じ語でも、氏名・記述の側が含めば合う）", () => {
    expect(matchesFilter(row({ patientName: "山田 025" }), { date: "all", q: "025" })).toBe(true);
    expect(matchesFilter(row({ studyDescription: "胸部CT 025" }), { date: "all", q: "025" })).toBe(true);
  });

  it("氏名の検索は第3〜5成分（ミドル・接頭・接尾）まで含める。画面に出す値は姓と名のまま", () => {
    const view = row({ patientName: "Doe John", patientKana: "", patientNameAlphabetic: "Doe John" });
    attachSearchNames(view, "Doe^John^Michael^Dr^Jr.");
    for (const q of ["Michael", "Dr", "Jr.", "doe john michael", "John Michael Dr Jr."]) {
      expect(matchesFilter(view, { date: "all", q }), q).toBe(true);
    }
    expect(matchesFilter(view, { date: "all", q: "Smith" })).toBe(false);
    // 表示の値は変わらない
    expect(view.patientName).toBe("Doe John");
    expect(view.patientNameAlphabetic).toBe("Doe John");
    // 結びつけていない行は、画面に出す値で探す
    expect(matchesFilter(row({ patientName: "Doe John", patientKana: "", patientNameAlphabetic: "Doe John" }), { date: "all", q: "Michael" })).toBe(false);
  });

  it("氏名の検索は、画面の項目が許可されている氏名の値だけを使う（隠した氏名は、第3〜5成分でも探せない）", () => {
    const pn = "Yamada^Taro^Michael=山田^太郎^^様=やまだ^たろう^みちる";
    const all = row();
    attachSearchNames(all, pn);
    expect(matchesFilter(all, { date: "all", q: "Michael" })).toBe(true);
    expect(matchesFilter(all, { date: "all", q: "様" })).toBe(true);
    expect(matchesFilter(all, { date: "all", q: "みちる" })).toBe(true);

    // 漢字とかなを許可しない役割：英字の第3成分だけ当たる
    const alphabeticOnly = row();
    delete alphabeticOnly.patientName;
    delete alphabeticOnly.patientKana;
    attachSearchNames(alphabeticOnly, pn);
    expect(matchesFilter(alphabeticOnly, { date: "all", q: "Michael" })).toBe(true);
    expect(matchesFilter(alphabeticOnly, { date: "all", q: "様" })).toBe(false);
    expect(matchesFilter(alphabeticOnly, { date: "all", q: "みちる" })).toBe(false);

    // 氏名を許可しない役割：氏名では探せない
    const none = row();
    delete none.patientName;
    delete none.patientKana;
    delete none.patientNameAlphabetic;
    attachSearchNames(none, pn);
    expect(matchesFilter(none, { date: "all", q: "Michael" })).toBe(false);
    expect(matchesFilter(none, { date: "all", q: "山田" })).toBe(false);
  });

  it("許可されていない項目（view に無い項目）では探せない", () => {
    const hidden = row();
    delete hidden.patientName;
    delete hidden.patientKana;
    delete hidden.patientNameAlphabetic;
    expect(matchesFilter(hidden, { date: "all", q: "山田" })).toBe(false);
    expect(matchesFilter(hidden, { date: "all", q: "JP-TEST-0001" })).toBe(true);
  });

  it("検索の字のそろえ方", () => {
    expect(normalizeForSearch("ヤマダ　タロウ")).toBe("やまだたろう");
    expect(normalizeForSearch("ＡＢＣ")).toBe("abc");
  });
});
