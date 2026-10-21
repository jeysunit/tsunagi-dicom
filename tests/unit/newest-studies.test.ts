import { describe, expect, it } from "vitest";
import { inDateRange, sortStudiesNewestFirst } from "@/lib/backend/dicom-json";
import { collectNewestStudies, MAX_WINDOW_QUERIES, warnsMoreResults, type WindowAnswer } from "@/lib/backend/newest-studies";
import type { StudyQuery, StudySummary } from "@/lib/backend/types";

// 返す順を決めていない QIDO-RS から、検査日の新しい順に上限の数を集める（docs/spec.md の 3.1「上限に届いたとき」。PS3.18 8.3.4.4）。
// 偽の画像サーバーは、入れた順（新しい検査ほど後）に limit 件までを返し、続きがあれば more にする（Orthanc の
// 入れた順の答えに近い形。どの検査を返すかを、検査日と関わりなく決める）。

const TODAY = "20261021";

function study(i: number, date: string, time = "090000"): StudySummary {
  return {
    studyInstanceUid: `1.2.3.${i}`,
    patientId: `P-${i}`,
    patientName: "",
    patientBirthDate: "",
    patientSex: "",
    studyDate: date,
    studyTime: time,
    accessionNumber: "",
    studyDescription: "",
    studyId: "",
    referringPhysicianName: "",
    modalities: ["CT"],
    seriesCount: 1,
    instanceCount: 1,
  };
}

/** 入れた順に limit + 1 件まで返す偽の QIDO-RS。呼ばれた条件を残す */
function fakeQido(stored: StudySummary[], ask: number) {
  const calls: StudyQuery[] = [];
  const fetchWindow = async (query: StudyQuery): Promise<WindowAnswer> => {
    calls.push(query);
    const matched = stored.filter((s) => inDateRange(s.studyDate, query));
    return { rows: matched.slice(0, ask), more: matched.length >= ask };
  };
  return { fetchWindow, calls };
}

/** n 日前の `YYYYMMDD`（TODAY から数える） */
function daysAgo(n: number): string {
  const d = new Date(Date.UTC(2026, 9, 21) - n * 86_400_000);
  return d.toISOString().slice(0, 10).replaceAll("-", "");
}

const uids = (rows: StudySummary[]) => rows.map((s) => s.studyInstanceUid);

describe("検査日の新しい順の上限の数を集める", () => {
  it("上限に届かなければ 1 回で全部（complete）。並びは新しい順", async () => {
    const stored = [study(1, daysAgo(3)), study(2, daysAgo(0)), study(3, daysAgo(10))];
    const { fetchWindow, calls } = fakeQido(stored, 11);
    const r = await collectNewestStudies(fetchWindow, 10, undefined, TODAY);
    expect(r.complete).toBe(true);
    expect(uids(r.studies)).toEqual(["1.2.3.2", "1.2.3.1", "1.2.3.3"]);
    expect(calls).toHaveLength(1);
  });

  it("上限を超えて、新しい検査ほど後に入っていても、新しい順の上限の数を返す（入れた順の先頭で切らない）", async () => {
    // 古い検査から順に入れる：2000 日前から毎日 1 件ずつ、最後に今日の 1 件
    const stored = [...Array.from({ length: 2000 }, (_, i) => study(i, daysAgo(2000 - i))), study(9999, daysAgo(0))];
    const { fetchWindow, calls } = fakeQido(stored, 11);
    const r = await collectNewestStudies(fetchWindow, 10, undefined, TODAY);
    expect(r.complete).toBe(false);
    expect(uids(r.studies)).toEqual(uids(sortStudiesNewestFirst(stored).slice(0, 10)));
    expect(r.studies[0]!.studyInstanceUid).toBe("1.2.3.9999");
    expect(calls.length).toBeLessThanOrEqual(MAX_WINDOW_QUERIES);
  });

  it("上限の数より多い検査が古い範囲に固まっていても、範囲を分けて新しい側から取る", async () => {
    // 3 年前から 4 年前に 500 件、今日に 3 件。上限 10 件は、今日の 3 件と、3 年前の側の新しい 7 件
    const stored = [
      ...Array.from({ length: 500 }, (_, i) => study(i, daysAgo(1095 + (i % 365)))),
      ...Array.from({ length: 3 }, (_, i) => study(1000 + i, daysAgo(0))),
    ];
    const { fetchWindow } = fakeQido(stored, 11);
    const r = await collectNewestStudies(fetchWindow, 10, undefined, TODAY);
    expect(uids(r.studies)).toEqual(uids(sortStudiesNewestFirst(stored).slice(0, 10)));
  });

  it("1 日に上限より多い検査があれば、その日の中は画像サーバーが返したもの（complete ではない）", async () => {
    const stored = [...Array.from({ length: 30 }, (_, i) => study(i, daysAgo(1))), study(100, daysAgo(5))];
    const { fetchWindow } = fakeQido(stored, 11);
    const r = await collectNewestStudies(fetchWindow, 10, undefined, TODAY);
    expect(r.complete).toBe(false);
    expect(r.studies).toHaveLength(10);
    expect(r.studies.every((s) => s.studyDate === daysAgo(1))).toBe(true);
  });

  it("検査日の範囲の条件の中だけを区切る（範囲の外を問い合わせない）。未来の日付・とても古い日付も漏らさない", async () => {
    const stored = [
      ...Array.from({ length: 40 }, (_, i) => study(i, daysAgo(400 + i))),
      study(500, "20991231"),
      study(501, "18900101"),
    ];
    const ranged = fakeQido(stored, 11);
    const r = await collectNewestStudies(ranged.fetchWindow, 10, { dateFrom: daysAgo(420), dateTo: daysAgo(400) }, TODAY);
    expect(uids(r.studies)).toEqual(uids(sortStudiesNewestFirst(stored.filter((s) => inDateRange(s.studyDate, { dateFrom: daysAgo(420), dateTo: daysAgo(400) }))).slice(0, 10)));
    for (const q of ranged.calls) {
      expect(q.dateFrom! >= daysAgo(420) && q.dateTo! <= daysAgo(400)).toBe(true);
    }
    // 全期間：未来の検査がいちばん上。とても古い検査は、上限の外なので出ない
    const all = fakeQido(stored, 11);
    const r2 = await collectNewestStudies(all.fetchWindow, 10, undefined, TODAY);
    expect(r2.studies[0]!.studyInstanceUid).toBe("1.2.3.500");
    // 上限を広げれば、とても古い検査も取れる（区切りの外に落ちない）
    const wide = fakeQido(stored, 41);
    const r3 = await collectNewestStudies(wide.fetchWindow, 40, undefined, TODAY);
    expect(r3.studies).toHaveLength(40);
    const all42 = fakeQido(stored, 43);
    expect((await collectNewestStudies(all42.fetchWindow, 42, undefined, TODAY)).complete).toBe(true);
  });

  it("問い合わせの回数の上限に届いたら、そこまでの新しい側の検査を返す（間の抜けた並びにしない）", async () => {
    // 1 日に 1 件ずつ、5000 日。上限 1000 件を 1 回の問い合わせで 10 件ずつしか取れないと、回数の上限に届く
    const stored = Array.from({ length: 5000 }, (_, i) => study(i, daysAgo(i)));
    const { fetchWindow, calls } = fakeQido(stored, 11);
    const r = await collectNewestStudies(fetchWindow, 1000, undefined, TODAY);
    expect(calls).toHaveLength(MAX_WINDOW_QUERIES);
    expect(r.complete).toBe(false);
    expect(uids(r.studies)).toEqual(uids(sortStudiesNewestFirst(stored).slice(0, r.studies.length)));
  });

  it("画像サーバーが求めた数より少なく切っても（maxResults）、読み残しのある日より古い検査を足さない", async () => {
    // 1 回に 100 件までしか返さない画像サーバー（続きは Warning 299 で知らせる）。今日 200 件・昨日 1 件
    const stored = [study(1, daysAgo(1)), ...Array.from({ length: 200 }, (_, i) => study(100 + i, daysAgo(0)))];
    const calls: StudyQuery[] = [];
    const capped = async (query: StudyQuery): Promise<WindowAnswer> => {
      calls.push(query);
      const matched = stored.filter((s) => inDateRange(s.studyDate, query));
      return { rows: matched.slice(0, 100), more: matched.length > 100 };
    };
    const r = await collectNewestStudies(capped, 1000, undefined, TODAY);
    expect(r.complete).toBe(false);
    // 今日の 100 件だけ（今日を読み残したまま、昨日の検査を足さない）
    expect(r.studies).toHaveLength(100);
    expect(r.studies.every((s) => s.studyDate === daysAgo(0))).toBe(true);
  });

  it("最初の答えに続きがあっても、区切った範囲を全部読みきれば complete（上限で切った画像サーバーと Warning 299）", async () => {
    // 1 回に 10 件までの画像サーバー。検査は 15 件（1 日に 1 件）。上限 20 件で求めると、最初は 10 件と Warning 299
    const stored = Array.from({ length: 15 }, (_, i) => study(i, daysAgo(i * 3)));
    const capped = async (query: StudyQuery): Promise<WindowAnswer> => {
      const matched = stored.filter((s) => inDateRange(s.studyDate, query));
      return { rows: matched.slice(0, 10), more: matched.length > 10 };
    };
    const r = await collectNewestStudies(capped, 20, { dateFrom: "20000101" }, TODAY);
    expect(r.complete).toBe(true);
    expect(uids(r.studies)).toEqual(uids(sortStudiesNewestFirst(stored)));
  });

  it("検査日の条件の無い検索で問い合わせ直したときは、検査日の無い検査を引けたか分からないので complete にしない", async () => {
    // 検査日のある 15 件と、検査日の無い 1 件。1 回に 10 件までの画像サーバー
    const stored = [...Array.from({ length: 15 }, (_, i) => study(i, daysAgo(i * 3))), study(99, "")];
    const capped = async (query: StudyQuery): Promise<WindowAnswer> => {
      const matched = stored.filter((s) => inDateRange(s.studyDate, query));
      return { rows: matched.slice(0, 10), more: matched.length > 10 };
    };
    const r = await collectNewestStudies(capped, 20, undefined, TODAY);
    expect(r.studies).toHaveLength(15);
    expect(r.complete).toBe(false);
  });

  it("上限の数に届いて古い範囲を読まなかったときは complete にしない", async () => {
    const stored = Array.from({ length: 30 }, (_, i) => study(i, daysAgo(i)));
    const { fetchWindow } = fakeQido(stored, 11);
    const r = await collectNewestStudies(fetchWindow, 10, undefined, TODAY);
    expect(r.complete).toBe(false);
    expect(uids(r.studies)).toEqual(uids(sortStudiesNewestFirst(stored).slice(0, 10)));
  });

  it("答えの Warning 299 を「続きがある」と読む（PS3.18 8.3.4.4.1）", () => {
    expect(warnsMoreResults("299 orthanc: There are 5 additional results that can be requested")).toBe(true);
    expect(warnsMoreResults('110 - "Response is Stale", 299 x: There are 1 additional results that can be requested')).toBe(true);
    expect(warnsMoreResults('199 - "misc"')).toBe(false);
    expect(warnsMoreResults("2990 x")).toBe(false);
    expect(warnsMoreResults(null)).toBe(false);
  });
});
