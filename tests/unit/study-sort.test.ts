import { describe, expect, it } from "vitest";
import type { StudyView } from "@/lib/fields";
import { DEFAULT_SORT, isDefaultSort, nextSort, sortStudies } from "@/lib/study-sort";

// 検査の一覧の列見出しでの並べ替え（docs/spec.md の 3.1）。

const view = (uid: string, rest: Partial<StudyView> = {}): StudyView => ({ studyInstanceUid: uid, ...rest });
const uids = (studies: StudyView[]) => studies.map((s) => s.studyInstanceUid);

describe("見出しを押したときの次の並び", () => {
  it("別の列は昇順から、同じ列は昇順と降順を入れ替える", () => {
    expect(nextSort(DEFAULT_SORT, "id")).toEqual({ key: "id", dir: "asc" });
    expect(nextSort({ key: "id", dir: "asc" }, "id")).toEqual({ key: "id", dir: "desc" });
    expect(nextSort({ key: "id", dir: "desc" }, "id")).toEqual({ key: "id", dir: "asc" });
    // 検査日時も、最初の降順を押すと昇順になる
    expect(nextSort(DEFAULT_SORT, "date")).toEqual({ key: "date", dir: "asc" });
  });

  it("読み込み直後の並びは検査日時の降順", () => {
    expect(isDefaultSort(DEFAULT_SORT)).toBe(true);
    expect(isDefaultSort({ key: "date", dir: "asc" })).toBe(false);
    expect(isDefaultSort({ key: "id", dir: "desc" })).toBe(false);
  });
});

describe("並べ替え", () => {
  const a = view("a", { patientId: "P10", studyDate: "20260102", studyTime: "090000" });
  const b = view("b", { patientId: "P9", studyDate: "20260102", studyTime: "083000" });
  const c = view("c", { patientId: "P100", studyDate: "20251231", studyTime: "235959" });

  it("検査日時：日と時刻の順", () => {
    expect(uids(sortStudies([a, b, c], { key: "date", dir: "asc" }))).toEqual(["c", "b", "a"]);
    expect(uids(sortStudies([c, b, a], { key: "date", dir: "desc" }))).toEqual(["a", "b", "c"]);
  });

  it("患者 ID：数字は数の大きさで比べる（P9 は P10 の前）", () => {
    expect(uids(sortStudies([a, b, c], { key: "id", dir: "asc" }))).toEqual(["b", "a", "c"]);
    expect(uids(sortStudies([a, b, c], { key: "id", dir: "desc" }))).toEqual(["c", "a", "b"]);
  });

  it("元の配列は変えない", () => {
    const input = [a, b, c];
    sortStudies(input, { key: "id", dir: "asc" });
    expect(uids(input)).toEqual(["a", "b", "c"]);
  });

  it("同じ値の行は、渡された順のまま（昇順でも降順でも）", () => {
    const x = view("x", { patientSex: "F" });
    const y = view("y", { patientSex: "F" });
    const z = view("z", { patientSex: "M" });
    expect(uids(sortStudies([x, z, y], { key: "sex", dir: "asc" }))).toEqual(["x", "y", "z"]);
    expect(uids(sortStudies([x, z, y], { key: "sex", dir: "desc" }))).toEqual(["z", "x", "y"]);
  });

  it("値の無い行は、昇順でも降順でも最後", () => {
    const none = view("none");
    expect(uids(sortStudies([none, a, b], { key: "id", dir: "asc" }))).toEqual(["b", "a", "none"]);
    expect(uids(sortStudies([none, a, b], { key: "id", dir: "desc" }))).toEqual(["a", "b", "none"]);
  });

  it("氏名：かなの氏名があれば五十音順、無ければ氏名", () => {
    const sato = view("sato", { patientName: "佐藤 太郎", patientKana: "サトウ タロウ" });
    const abe = view("abe", { patientName: "安倍 次郎", patientKana: "アベ ジロウ" });
    const doe = view("doe", { patientName: "DOE JOHN" });
    expect(uids(sortStudies([sato, abe], { key: "name", dir: "asc" }))).toEqual(["abe", "sato"]);
    // かなの無い行は氏名で比べる（漢字と英字の前後は照合順）。値のある行は、無い行より前
    const sorted = uids(sortStudies([sato, doe, abe], { key: "name", dir: "asc" }));
    expect(sorted.indexOf("abe")).toBeLessThan(sorted.indexOf("sato"));
    expect(sorted).toHaveLength(3);
  });

  it("かな：全角半角・かなとカナの違いをそろえて比べる", () => {
    const hira = view("hira", { patientKana: "あべ" });
    const kata = view("kata", { patientKana: "ｱﾍﾞ" });
    const sa = view("sa", { patientKana: "サトウ" });
    expect(uids(sortStudies([sa, kata, hira], { key: "kana", dir: "asc" }))).toEqual(["kata", "hira", "sa"]);
  });

  it("年齢：昇順は若い順", () => {
    const old = view("old", { patientBirthDate: "19400101", studyDate: "20260101" });
    const young = view("young", { patientBirthDate: "20150101", studyDate: "20260101" });
    const none = view("none");
    expect(uids(sortStudies([old, none, young], { key: "age", dir: "asc" }))).toEqual(["young", "old", "none"]);
    expect(uids(sortStudies([old, none, young], { key: "age", dir: "desc" }))).toEqual(["old", "young", "none"]);
    // 生年月日の列は生年月日の順
    expect(uids(sortStudies([young, old], { key: "birth", dir: "asc" }))).toEqual(["old", "young"]);
  });

  it("年齢：列に出す、検査日の時点の満年齢で比べる（検査日が違っても）", () => {
    // 2000 年生まれを 2025 年に検査（25歳）と、1990 年生まれを 2000 年に検査（10歳）
    const adult = view("adult", { patientBirthDate: "20000101", studyDate: "20250601" });
    const child = view("child", { patientBirthDate: "19900101", studyDate: "20000601" });
    const noDate = view("noDate", { patientBirthDate: "19800101" });
    expect(uids(sortStudies([adult, noDate, child], { key: "age", dir: "asc" }))).toEqual(["child", "adult", "noDate"]);
    expect(uids(sortStudies([adult, noDate, child], { key: "age", dir: "desc" }))).toEqual(["adult", "child", "noDate"]);
    // 同じ年齢は読んだ順のまま
    const same = view("same", { patientBirthDate: "20000101", studyDate: "20250101" });
    expect(uids(sortStudies([adult, same], { key: "age", dir: "asc" }))).toEqual(["adult", "same"]);
  });

  it("検査日時：検査日の無い行は、昇順でも降順でも最後", () => {
    const dated = view("dated", { studyDate: "20260101", studyTime: "0900" });
    const undated = view("undated");
    expect(uids(sortStudies([undated, dated], { key: "date", dir: "asc" }))).toEqual(["dated", "undated"]);
    expect(uids(sortStudies([undated, dated], { key: "date", dir: "desc" }))).toEqual(["dated", "undated"]);
  });

  it("患者 ID・受付番号：全角半角・大文字小文字の違いは同じ値として、読んだ順のまま", () => {
    const upper = view("upper", { patientId: "ABC1", accessionNumber: "ACC1" });
    const lower = view("lower", { patientId: "abc1", accessionNumber: "acc1" });
    const wide = view("wide", { patientId: "ＡＢＣ１", accessionNumber: "ＡＣＣ１" });
    const after = view("after", { patientId: "abc2", accessionNumber: "acc2" });
    expect(uids(sortStudies([after, wide, lower, upper], { key: "id", dir: "asc" }))).toEqual(["wide", "lower", "upper", "after"]);
    expect(uids(sortStudies([after, wide, lower, upper], { key: "accession", dir: "asc" }))).toEqual(["wide", "lower", "upper", "after"]);
  });

  it("モダリティ／検査名：モダリティ、検査名の順", () => {
    const ct = view("ct", { modalities: ["CT"], studyDescription: "胸部" });
    const mr = view("mr", { modalities: ["MR"], studyDescription: "頭部" });
    const ct2 = view("ct2", { modalities: ["CT"], studyDescription: "腹部" });
    expect(uids(sortStudies([mr, ct2, ct], { key: "desc", dir: "asc" }))).toEqual(["ct", "ct2", "mr"]);
  });
});
