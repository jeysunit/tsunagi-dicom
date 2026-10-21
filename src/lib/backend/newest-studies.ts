import { sortStudiesNewestFirst } from "@/lib/backend/dicom-json";
import type { StudyQuery, StudySearch, StudySummary } from "@/lib/backend/types";

// 検査日の新しい順に上限の数の検査を、返す順を決めていない QIDO-RS から集める（docs/spec.md の 3.1「上限に届いたとき」）。
// QIDO-RS の limit は「返す数の上限」で、どの検査を返すかの順は決めていない。続きがあるときは
// `Warning: 299 …` で知らせる（PS3.18 8.3.4.4・8.3.4.4.1）。だから、limit で切った答えを「新しい順の上限の数」とみなさない。
//
// 1. まず条件のまま 1 回問い合わせる。続きが無ければ（返した数が求めた数に届かず、Warning 299 も無い）、それで全部。
// 2. 続きがあれば、検査日の範囲を新しい側から区切って問い合わせ直す（明日より後 → 今日までの 7 日 → 30 日 → 1 年 → 5 年 → それより前）。
//    区切った範囲でも続きがあれば、その範囲を半分に分けて、新しい側から問い合わせる。1 日に収まっても続きがあれば、
//    その日の中は全部とは限らない（どの検査を返すかは画像サーバーが決める）ので、その日で止める（古い日へ進まない）。
// 3. 新しい側から上限の数に届いたら止める。問い合わせの回数にも上限（MAX_WINDOW_QUERIES）を置き、届いたら、
//    そこまでに集めた検査を返す（新しい側から欠けなく並ぶ。上限の数より少ないことがある）。
// 区切った範囲を全部読みきり、上限で切り捨てた検査も無ければ、全部を返した（complete）とする。
// 検査日の無い検査は、2 の問い合わせ（検査日の範囲の条件）には合わない。続きがあるときは、一覧に出ないことがある。

/** 1 回の問い合わせの答え。more：求めた数に届いたか、Warning 299 があった（画像サーバーに続きがある） */
export interface WindowAnswer {
  rows: StudySummary[];
  more: boolean;
}

export type FetchWindow = (query: StudyQuery) => Promise<WindowAnswer>;

/** 1 回の検索で、区切った範囲を問い合わせる回数の上限（最初の 1 回を含む） */
export const MAX_WINDOW_QUERIES = 40;

const DAY_MS = 86_400_000;

/** `YYYYMMDD` を 1970-01-01 からの日の数にする。形が違えば undefined */
function dayOf(da: string | undefined): number | undefined {
  const m = da ? /^(\d{4})(\d{2})(\d{2})$/.exec(da) : null;
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS : undefined;
}

function daOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll("-", "");
}

const DAY_1900 = dayOf("19000101")!;
const DAY_9999 = dayOf("99991231")!;

/** 検査日の範囲（日の数）。undefined は端が開いている */
interface Range {
  from?: number;
  to?: number;
}

/** `Warning` のヘッダーに、続きがあることの知らせ（警告の番号 299）があるか */
export function warnsMoreResults(warning: string | null | undefined): boolean {
  return !!warning && /(^|,)\s*299\s/.test(warning);
}

/** 新しい側から区切る範囲（基準の日 anchor から数える） */
function windowsFrom(anchor: number): Range[] {
  return [
    { from: anchor + 1 },
    { from: anchor - 6, to: anchor },
    { from: anchor - 30, to: anchor - 7 },
    { from: anchor - 365, to: anchor - 31 },
    { from: anchor - 1825, to: anchor - 366 },
    { to: anchor - 1826 },
  ];
}

/** 範囲を新しい側と古い側の半分に分ける。1 日なら分けられない（null） */
function split(range: Range): { upper: Range; lower: Range } | null {
  const lo = range.from ?? Math.min(DAY_1900, (range.to ?? DAY_9999) - 1);
  const hi = range.to ?? Math.max(DAY_9999, lo + 1);
  if (lo >= hi) return null;
  const mid = Math.floor((lo + hi) / 2);
  return { upper: { from: mid + 1, to: range.to }, lower: { from: range.from, to: mid } };
}

const newest = (rows: StudySummary[], count: number) => sortStudiesNewestFirst(rows).slice(0, count);

/**
 * 検査日の新しい順に limit 件まで集める。fetchWindow は、条件（検査日の範囲を含む）で 1 回問い合わせ、
 * 答えの行（BFF の側で条件を確かめ直したもの）と、続きがあるかを返す。today（`YYYYMMDD`）は区切りの基準
 */
export async function collectNewestStudies(fetchWindow: FetchWindow, limit: number, query: StudyQuery | undefined, today: string): Promise<StudySearch> {
  const base: StudyQuery = { ...query };
  const first = await fetchWindow(base);
  if (!first.more) return { studies: newest(first.rows, limit), complete: first.rows.length <= limit };

  const bounds: Range = { from: dayOf(base.dateFrom), to: dayOf(base.dateTo) };
  let queries = 1;
  const ask = async (range: Range): Promise<WindowAnswer | null> => {
    if (queries >= MAX_WINDOW_QUERIES) return null;
    queries += 1;
    return fetchWindow({
      ...base,
      dateFrom: range.from === undefined ? undefined : daOf(range.from),
      dateTo: range.to === undefined ? undefined : daOf(range.to),
    });
  };
  // complete：区切ったどの範囲も読みきり、上限で切り捨てた検査も無い。
  // stopped：読みきれなかった範囲がある（1 日に収まっても続きがある・回数の上限に届いた）。そこより古い範囲へは進まない
  // （進むと、新しい側に読み残しを抱えたまま古い検査を足し、「新しい側から欠けなく並ぶ」が崩れる。
  // 画像サーバーが limit より少ない数で切ることも、規格は認めている（PS3.18 8.3.4.4.1 の maxResults））
  let complete = true;
  let stopped = false;
  const collect = async (range: Range, need: number): Promise<StudySummary[]> => {
    const answer = await ask(range);
    if (!answer) {
      complete = false;
      stopped = true;
      return [];
    }
    const halves = answer.more ? split(range) : null;
    if (!halves) {
      if (answer.more) {
        complete = false;
        stopped = true;
      } else if (answer.rows.length > need) {
        complete = false;
      }
      return newest(answer.rows, need);
    }
    const upper = await collect(halves.upper, need);
    if (stopped) return upper.slice(0, need);
    if (upper.length >= need) {
      // 古い側の半分は読んでいない
      complete = false;
      return upper.slice(0, need);
    }
    return [...upper, ...(await collect(halves.lower, need - upper.length))];
  };

  const ranges = windowsFrom(dayOf(today) ?? Math.floor(Date.now() / DAY_MS))
    .map(
      (w): Range => ({
        from: w.from === undefined ? bounds.from : bounds.from === undefined ? w.from : Math.max(w.from, bounds.from),
        to: w.to === undefined ? bounds.to : bounds.to === undefined ? w.to : Math.min(w.to, bounds.to),
      }),
    )
    .filter((r) => r.from === undefined || r.to === undefined || r.from <= r.to);
  const studies: StudySummary[] = [];
  for (const range of ranges) {
    const need = limit - studies.length;
    if (need <= 0 || stopped) {
      // 読んでいない範囲が残る
      complete = false;
      break;
    }
    studies.push(...(await collect(range, need)));
  }
  return { studies: newest(studies, limit), complete };
}

/** 区切りの基準の日（UTC の今日。区切りの位置を決めるだけで、どの範囲も漏らさない） */
export function todayForWindows(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "");
}
