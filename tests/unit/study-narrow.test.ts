import { afterEach, describe, expect, it } from "vitest";
import { forgetSearches, recentSearches, rememberSearch, SEARCH_HISTORY_MAX } from "@/lib/client/search-history";
import { DEFAULT_FILTER, narrowToDay, narrowToModality, narrowToPatient, PERIOD_FORMAT_ERROR, PERIOD_ORDER_ERROR, readPeriodField } from "@/lib/study-filter";

// 検査一覧の検索の改善（docs/spec.md の 3.1「検査日の短縮入力」「セルから同じ値で絞る」「検索語の履歴」）。

describe("検査日の短縮入力（readPeriodField）", () => {
  it("空は何も返さない（条件にしない）", () => {
    expect(readPeriodField("")).toEqual({});
    expect(readPeriodField("  ")).toEqual({});
  });

  it("YYYYMMDD はその日、YYYYMM はその月（閏年の 2 月を含む）、YYYY はその年", () => {
    expect(readPeriodField("20260415")).toEqual({ from: "2026-04-15", to: "2026-04-15", hint: "2026/04/15" });
    expect(readPeriodField("202604")).toEqual({ from: "2026-04-01", to: "2026-04-30", hint: "2026/04/01 〜 2026/04/30" });
    expect(readPeriodField("202402")).toMatchObject({ from: "2024-02-01", to: "2024-02-29" });
    expect(readPeriodField("202302")).toMatchObject({ from: "2023-02-01", to: "2023-02-28" });
    expect(readPeriodField("2026")).toEqual({ from: "2026-01-01", to: "2026-12-31", hint: "2026/01/01 〜 2026/12/31" });
  });

  it("区切りの / は付けても付けなくてもよく、全角の数字・ハイフンも読む", () => {
    expect(readPeriodField("2026/04")).toMatchObject({ from: "2026-04-01", to: "2026-04-30" });
    expect(readPeriodField("2026/4/5")).toMatchObject({ from: "2026-04-05", to: "2026-04-05" });
    expect(readPeriodField("２０２６０４")).toMatchObject({ from: "2026-04-01", to: "2026-04-30" });
    expect(readPeriodField("２０２６０４－")).toMatchObject({ from: "2026-04-01" });
  });

  it("A- は A の初めから（終わりは無い）、-B は B の終わりまで（始まりは無い）、A-B は範囲", () => {
    const open = readPeriodField("202604-");
    expect(open).toEqual({ from: "2026-04-01", hint: "2026/04/01 〜" });
    expect(open).not.toHaveProperty("to");
    const upTo = readPeriodField("-202604");
    expect(upTo).toEqual({ to: "2026-04-30", hint: "〜 2026/04/30" });
    expect(upTo).not.toHaveProperty("from");
    expect(readPeriodField("202601-202604")).toEqual({ from: "2026-01-01", to: "2026-04-30", hint: "2026/01/01 〜 2026/04/30" });
    expect(readPeriodField("2025-2026")).toMatchObject({ from: "2025-01-01", to: "2026-12-31" });
    expect(readPeriodField("20260415-20260420")).toMatchObject({ from: "2026-04-15", to: "2026-04-20" });
  });

  it("読めない入力は誤りの文だけを返し、条件にしない", () => {
    for (const bad of ["abc", "2026-13", "202613", "20260230", "20260", "2026041", "1899", "-", "--", "2026-04-05", "2026/13", "2026//04"]) {
      const read = readPeriodField(bad);
      expect(read, bad).toEqual({ message: PERIOD_FORMAT_ERROR });
    }
  });

  it("終わりが始まりより前のときは誤り（順序）", () => {
    expect(readPeriodField("202604-202601")).toEqual({ message: PERIOD_ORDER_ERROR });
    expect(readPeriodField("20260420-20260415")).toEqual({ message: PERIOD_ORDER_ERROR });
  });

  it("同じ月の中の範囲（始まりが月の初め、終わりが月の終わり）は、順序が逆にならない", () => {
    expect(readPeriodField("202604-202604")).toMatchObject({ from: "2026-04-01", to: "2026-04-30" });
  });
});

describe("セルから同じ値で絞る", () => {
  it("患者 ID：全期間の検索の欄だけにする（検査日・モダリティ・詳細条件は外す）", () => {
    expect(narrowToPatient("JP-TEST-0004")).toEqual({ date: "all", q: "JP-TEST-0004" });
    expect(narrowToPatient(" JP-TEST-0004 ")).toEqual({ date: "all", q: "JP-TEST-0004" });
    expect(narrowToPatient("")).toBeNull();
    expect(narrowToPatient(undefined)).toBeNull();
  });

  it("検査日：その 1 日の期間指定にして、ほかの条件は残す", () => {
    const base = { ...DEFAULT_FILTER, q: "yama", modalities: ["CT" as const], sex: "F" as const };
    expect(narrowToDay(base, "20261015")).toEqual({ ...base, date: "range", from: "2026-10-15", to: "2026-10-15" });
    expect(narrowToDay(base, "")).toBeNull();
    expect(narrowToDay(base, "20261301")).toBeNull();
  });

  it("モダリティ：その群だけを選び、ほかの条件は残す。群に入らない値（OT など）は null", () => {
    const base = { ...DEFAULT_FILTER, q: "yama", modalities: ["CT" as const, "MR" as const] };
    expect(narrowToModality(base, "MR")).toEqual({ ...base, modalities: ["MR"] });
    expect(narrowToModality(base, "dx")).toEqual({ ...base, modalities: ["CR/DX"] });
    expect(narrowToModality(base, "SR")).toEqual({ ...base, modalities: ["SR"] });
    expect(narrowToModality(base, "OT")).toBeNull();
  });
});

describe("検索語の履歴", () => {
  afterEach(forgetSearches);

  it("新しい順に 5 件まで。同じ語は 1 件にまとめて先頭へ移す。空は覚えない", () => {
    for (const w of ["a", "b", "c", "d", "e", "f"]) rememberSearch(w);
    expect(recentSearches()).toEqual(["f", "e", "d", "c", "b"]);
    expect(recentSearches()).toHaveLength(SEARCH_HISTORY_MAX);
    rememberSearch("c");
    expect(recentSearches()).toEqual(["c", "f", "e", "d", "b"]);
    rememberSearch("  ");
    rememberSearch("");
    expect(recentSearches()).toHaveLength(5);
    rememberSearch(" f ");
    expect(recentSearches()[0]).toBe("f");
    expect(recentSearches().filter((w) => w === "f")).toHaveLength(1);
  });

  it("ブラウザーの保存先には書かない", () => {
    const keys = Object.keys(globalThis).filter((k) => k === "localStorage" || k === "sessionStorage");
    rememberSearch("JP-TEST-0004");
    for (const k of keys) {
      const store = (globalThis as unknown as Record<string, Storage | undefined>)[k];
      expect(store?.length ?? 0).toBe(0);
    }
  });
});
