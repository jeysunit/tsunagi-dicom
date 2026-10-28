// 受信一覧の期間（docs/spec.md の 3.3）。今日・昨日・過去7日・期間を指定の 4 つ。
// 日の境はサーバーの時間帯（TZ。既定は Asia/Tokyo）の 0 時。画面の API と頁で同じものを使う。
// 境は [開始, 終了) の半開き：開始日の 0 時を含み、終了日の翌日の 0 時を含まない。

export const RECEIVE_PERIODS = ["today", "yesterday", "7d", "range"] as const;
export type ReceivePeriodKind = (typeof RECEIVE_PERIODS)[number];

export const RECEIVE_PERIOD_LABELS: Record<ReceivePeriodKind, string> = {
  today: "今日",
  yesterday: "昨日",
  "7d": "過去7日",
  range: "期間を指定",
};

export interface ReceivePeriod {
  kind: ReceivePeriodKind;
  /** 開始日（`YYYY-MM-DD`。サーバーの時間帯の日付） */
  from: string;
  /** 終了日（`YYYY-MM-DD`。この日を含む） */
  to: string;
  /** 開始日の 0 時（UTC のミリ秒。含む） */
  fromMs: number;
  /** 終了日の翌日の 0 時（UTC のミリ秒。含まない） */
  toMs: number;
}

/** 期間を読めないとき（画面の API は 400 にする） */
export class ReceivePeriodError extends Error {}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `YYYY-MM-DD` を、暦にある日として読む。読めなければ null */
function parseDay(value: string): { y: number; m: number; d: number } | null {
  const match = DAY.exec(value);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return { y, m, d };
}

/** 日を n 日ずらす（暦の上で。時間帯に依らない） */
function shiftDay(value: string, days: number): string {
  const p = parseDay(value)!;
  const t = new Date(0);
  t.setUTCFullYear(p.y, p.m - 1, p.d + days);
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/** 時刻 t（UTC のミリ秒）の、時間帯 timeZone での日付（`YYYY-MM-DD`） */
export function dayIn(t: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 時刻 t での、時間帯 timeZone の UTC からのずれ（ミリ秒） */
function offsetAt(t: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(t))
      .map((p) => [p.type, p.value]),
  );
  const local = new Date(0);
  local.setUTCFullYear(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  local.setUTCHours(Number(parts.hour), Number(parts.minute), Number(parts.second), 0);
  return local.getTime() - (t - (((t % 1000) + 1000) % 1000));
}

/** 時間帯 timeZone で、日 day の 0 時を UTC のミリ秒にする（夏時間の切り替わりの日も、その日の最初の時刻にする） */
export function startOfDayIn(day: string, timeZone: string): number {
  const p = parseDay(day)!;
  const wall = new Date(0);
  wall.setUTCFullYear(p.y, p.m - 1, p.d);
  const guess = wall.getTime();
  let t = guess - offsetAt(guess, timeZone);
  // ずれが日の中で変わる（夏時間）ときは、求めた時刻のずれで直す
  t = guess - offsetAt(t, timeZone);
  return t;
}

/**
 * 画面の API・頁の問い合わせ（period・from・to）から期間を決める。period が無ければ今日。
 * 期間を指定（range）は from と to（`YYYY-MM-DD`）が要り、from が to より後なら読めない
 */
export function resolveReceivePeriod(
  query: { period?: string | null; from?: string | null; to?: string | null },
  timeZone: string,
  now: number = Date.now(),
): ReceivePeriod {
  const kind = (query.period ?? "today") as ReceivePeriodKind;
  if (!RECEIVE_PERIODS.includes(kind)) throw new ReceivePeriodError("受信一覧の期間を読み込めません。期間の種類が合いません。期間を選び直してください");
  const today = dayIn(now, timeZone);
  let from: string;
  let to: string;
  if (kind === "today") [from, to] = [today, today];
  else if (kind === "yesterday") [from, to] = [shiftDay(today, -1), shiftDay(today, -1)];
  else if (kind === "7d") [from, to] = [shiftDay(today, -6), today];
  else {
    if (!query.from || !query.to || !parseDay(query.from) || !parseDay(query.to)) {
      throw new ReceivePeriodError("受信一覧の期間を読み込めません。開始日か終了日の形が合いません。期間を選び直してください");
    }
    [from, to] = [query.from, query.to];
    if (from > to) throw new ReceivePeriodError("受信一覧の期間を読み込めません。開始日が終了日より後です。期間を選び直してください");
  }
  return { kind, from, to, fromMs: startOfDayIn(from, timeZone), toMs: startOfDayIn(shiftDay(to, 1), timeZone) };
}

/** 期間を、画面の API・頁の URL の問い合わせにする（今日は何も付けない） */
export function receivePeriodQuery(period: Pick<ReceivePeriod, "kind" | "from" | "to">): URLSearchParams {
  const q = new URLSearchParams();
  if (period.kind === "today") return q;
  q.set("period", period.kind);
  if (period.kind === "range") {
    q.set("from", period.from);
    q.set("to", period.to);
  }
  return q;
}
