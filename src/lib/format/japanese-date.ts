// 日付・和暦・年齢・性別の整形（docs/spec.md の 3.1）。
// 生年月日は西暦の後ろの括弧に、元号の漢字 1 字（一覧の表は英字 1 字）と年・満年齢を並べる：`1975/05/14（昭50・51歳）`。
// 年齢は検査日の時点で数える。DICOM・HL7・CSV・API の値は西暦のままで、和暦は画面の表示と入力の読み取りだけに使う。
// DICOM の DA（YYYYMMDD）を読む。読めない値は例外にせず、出せる部分だけを出す。
// 生年月日の入力（西暦と元号）を読み取る parseBirthInput も、ここに置く（画面と BFF の両方で使う）。

export interface SimpleDate {
  year: number;
  month: number;
  day: number;
}

/** DICOM の DA（`YYYYMMDD`。古い形の `YYYY.MM.DD` も読む）。暦に無い日（2月30日など）は null */
export function parseDicomDate(value: unknown): SimpleDate | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})\.?(\d{2})\.?(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1) return null;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > last) return null;
  return { year, month, day };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `1975/05/10`。読めなければ空 */
export function formatSlashDate(value: unknown): string {
  const d = parseDicomDate(value);
  return d ? `${d.year}/${pad(d.month)}/${pad(d.day)}` : "";
}

/**
 * DICOM の TM を `09:30` にする。TM は `HH`・`HHMM`・`HHMMSS`・`HHMMSS.F…`（小数は 1〜6 桁）のどれか（PS3.5 6.2）。
 * 時だけの値（`07`）は分が分からないので `07:--` にする（`07:00` と書くと、無い値を足すことになる）。
 * 古い形の `HH:MM:SS`（ACR-NEMA）も読む。読めなければ空
 */
export function formatDicomTime(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = /^(\d{2})(?::?(\d{2})(?::?\d{2}(?:\.\d{1,6})?)?)?$/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || (m[2] !== undefined && Number(m[2]) > 59)) return "";
  return `${m[1]}:${m[2] ?? "--"}`;
}

/** 元号の正式名・漢字 1 字・英字 1 字と、その始まりの日（改元の日。グレゴリオ暦）。新しい元号から先に並べる */
export const ERAS = [
  { name: "令和", kanji: "令", letter: "R", start: { year: 2019, month: 5, day: 1 } },
  { name: "平成", kanji: "平", letter: "H", start: { year: 1989, month: 1, day: 8 } },
  { name: "昭和", kanji: "昭", letter: "S", start: { year: 1926, month: 12, day: 25 } },
  { name: "大正", kanji: "大", letter: "T", start: { year: 1912, month: 7, day: 30 } },
  { name: "明治", kanji: "明", letter: "M", start: { year: 1868, month: 10, day: 23 } },
] as const;

function compare(a: SimpleDate, b: SimpleDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * 元号と年：`昭50`（letter なら `S50`）。元年は短い表示では数字の 1（`平1`）。
 * 年 ＝ 西暦の年 − 元号の始まりの年 ＋ 1。明治より前（1868/10/22 以前）は空
 */
export function eraYear(date: SimpleDate, { letter = false }: { letter?: boolean } = {}): string {
  const era = ERAS.find((e) => compare(date, e.start) >= 0);
  return era ? `${letter ? era.letter : era.kanji}${date.year - era.start.year + 1}` : "";
}

/** `at` の日の時点の満年齢。誕生日の当日に上がる。2月29日生まれは、平年は3月1日に上がる。生まれる前なら null */
export function ageAt(birth: SimpleDate, at: SimpleDate): number | null {
  if (compare(at, birth) < 0) return null;
  let age = at.year - birth.year;
  if (at.month < birth.month || (at.month === birth.month && at.day < birth.day)) age -= 1;
  return age;
}

const SEX_LABELS: Record<string, string> = { M: "男", F: "女", O: "その他" };

/** DICOM の PatientSex（M・F・O）を `男`・`女`・`その他` にする。ほかは空 */
export function sexLabel(value: unknown): string {
  return typeof value === "string" ? (SEX_LABELS[value.trim().toUpperCase()] ?? "") : "";
}

/** 生年月日の括弧の中身：`昭50・51歳`。年齢は検査日（studyDate）の時点で、検査日が読めない・生まれる前なら出さない。何も無ければ空 */
function birthInside(birthDate: unknown, studyDate: unknown, letter: boolean): string {
  const birth = parseDicomDate(birthDate);
  if (!birth) return "";
  const at = parseDicomDate(studyDate);
  const age = at ? ageAt(birth, at) : null;
  return [eraYear(birth, { letter }), age === null ? "" : `${age}歳`].filter(Boolean).join("・");
}

/**
 * 患者の帯と確かめの欄の生年月日：西暦と、全角の括弧から後ろ（`.unit` で包むため分けて返す）。
 * `{ date: "1975/05/14", note: "（昭50・51歳）" }`。括弧の中が空なら note も空。生年月日が読めなければどちらも空
 */
export function birthParts(birthDate: unknown, studyDate: unknown): { date: string; note: string } {
  const date = formatSlashDate(birthDate);
  const inside = birthInside(birthDate, studyDate, false);
  return { date, note: inside ? `（${inside}）` : "" };
}

/** 帯の生年月日・性別を 1 つの文字にする：`1975/05/14（昭50・51歳）男`。出せない部分は飛ばし、何も無ければ空（title・確かめの欄の要約に使う） */
export function formatBirthLine(birthDate: unknown, sex: unknown, studyDate: unknown): string {
  const { date, note } = birthParts(birthDate, studyDate);
  return `${date}${note}${sexLabel(sex)}`;
}

/** 一覧の表の生年月日の列：`1975/05/14 (S50・51歳)`（英字 1 字。括弧は半角で、前に半角の空白を 1 つ置く）。読めなければ空 */
export function formatBirthCell(birthDate: unknown, studyDate: unknown): string {
  const date = formatSlashDate(birthDate);
  const inside = birthInside(birthDate, studyDate, true);
  return inside ? `${date} (${inside})` : date;
}

// ── 生年月日の入力の読み取り（docs/spec.md の 3.1「生年月日の入力」） ──

/** 形が合わないときの誤りの文 */
export const BIRTH_FORMAT_ERROR = "生年月日を読み取れません。1975/05/14 か S50/05/14 の形で入力してください。";
/** 今日より後のときの誤りの文 */
export const BIRTH_FUTURE_ERROR = "生年月日が今日より後です。日付を確かめてください。";

type Era = (typeof ERAS)[number];

/** 西暦 `1975/05/14`。年は 4 桁、月日の 0 は省いてよい */
const WESTERN_INPUT = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
/** 英字 1 字（半角・全角、大文字・小文字）か漢字 1 字＋年 `/M/D`：`S50/05/14`・`昭50/05/14`・`H元/01/08` */
const SHORT_ERA_INPUT = /^([A-Za-zＡ-Ｚａ-ｚ]|[明大昭平令])(\d{1,2}|元)\/(\d{1,2})\/(\d{1,2})$/;
/** 正式名＋年＋月＋日：`昭和50年5月14日`・`平成元年1月8日` */
const FORMAL_INPUT = /^(明治|大正|昭和|平成|令和)(\d{1,2}|元)年(\d{1,2})月(\d{1,2})日$/;

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** 暦にある日か（年は 1 以上）。`Date` は 0〜99 年を 1900 年代に読み替えるので使わない */
function isCalendarDate({ year, month, day }: SimpleDate): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const last = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day <= last;
}

const slashDate = (d: SimpleDate) => `${d.year}/${pad(d.month)}/${pad(d.day)}`;
const dicomDate = (d: SimpleDate) => `${String(d.year).padStart(4, "0")}${pad(d.month)}${pad(d.day)}`;

/** 元号の終わりの日（次の元号の始まりの前日）と、その日の元号の年 */
function eraEnd(era: Era, next: Era): { date: SimpleDate; year: number } {
  const { year, month, day } = next.start;
  const date = day > 1 ? { year, month, day: day - 1 } : month > 1
    ? { year, month: month - 1, day: month - 1 === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 2]! }
    : { year: year - 1, month: 12, day: 31 };
  return { date, year: date.year - era.start.year + 1 };
}

/** 全角の英字を半角の大文字にする（`ｓ` → `S`） */
function eraLetter(c: string): string {
  const code = c.charCodeAt(0);
  return (code >= 0xff21 && code <= 0xff5a ? String.fromCharCode(code - 0xfee0) : c).toUpperCase();
}

/** 元号の範囲を確かめる。範囲の外なら誤りの文（元号の名前と範囲を入れる） */
function eraRangeError(index: number, date: SimpleDate): string | null {
  const era = ERAS[index]!;
  const next = index > 0 ? ERAS[index - 1] : undefined;
  const prev = ERAS[index + 1];
  if (next && compare(date, next.start) >= 0) {
    const end = eraEnd(era, next);
    return `生年月日が${era.name}の範囲にありません。${era.name}は ${slashDate(end.date)} までです。${next.name}1年は ${slashDate(next.start)} からです。`;
  }
  if (compare(date, era.start) < 0) {
    const head = `生年月日が${era.name}の範囲にありません。${era.name}は ${slashDate(era.start)} からです。`;
    if (!prev) return head;
    const end = eraEnd(prev, era);
    return `${head}${prev.name}${end.year}年は ${slashDate(end.date)} までです。`;
  }
  return null;
}

/**
 * 生年月日の入力を読み取る。受ける形は西暦 `1975/05/14`、英字 1 字の `S50/05/14`、漢字 1 字の `昭50/05/14`、
 * 正式名の `昭和50年5月14日`（年の 1 は `元` でもよい。前後の空白は捨てる）。
 * 確かめる順は、形（暦に無い日を含む）→ 元号の範囲 → 今日より後。today は呼ぶ側が決める（画面は画面の今日、BFF はサーバーの今日）。
 * 読めたら日付と DICOM の DA（`YYYYMMDD`）を返す。空の入力は形が合わない扱い（空を許すかは呼ぶ側が決める）
 */
export function parseBirthInput(value: string, today: SimpleDate): { ok: true; date: SimpleDate; da: string } | { ok: false; message: string } {
  const text = value.trim();
  let date: SimpleDate;
  let eraIndex = -1;
  const western = WESTERN_INPUT.exec(text);
  if (western) {
    date = { year: Number(western[1]), month: Number(western[2]), day: Number(western[3]) };
  } else {
    const short = SHORT_ERA_INPUT.exec(text);
    const formal = short ? null : FORMAL_INPUT.exec(text);
    const m = short ?? formal;
    if (!m) return { ok: false, message: BIRTH_FORMAT_ERROR };
    const mark = m[1]!;
    eraIndex = ERAS.findIndex((e) => (formal ? e.name === mark : e.kanji === mark || e.letter === eraLetter(mark)));
    const year = m[2] === "元" ? 1 : Number(m[2]);
    if (eraIndex < 0 || year < 1) return { ok: false, message: BIRTH_FORMAT_ERROR };
    date = { year: ERAS[eraIndex]!.start.year + year - 1, month: Number(m[3]), day: Number(m[4]) };
  }
  if (!isCalendarDate(date)) return { ok: false, message: BIRTH_FORMAT_ERROR };
  if (eraIndex >= 0) {
    const rangeError = eraRangeError(eraIndex, date);
    if (rangeError) return { ok: false, message: rangeError };
  }
  if (compare(date, today) > 0) return { ok: false, message: BIRTH_FUTURE_ERROR };
  return { ok: true, date, da: dicomDate(date) };
}

/**
 * 入力欄の下の読み取り結果：`1975/05/14（昭50・51歳）`（帯と同じ漢字 1 字の形。性別は付けない）。
 * 年齢は at の日（検査に結び付く画面は検査日、結び付かない画面は開いた日）で数え、at より後の生年月日は年齢を出さない
 */
export function birthInputHint(date: SimpleDate, at: SimpleDate): string {
  const { date: shown, note } = birthParts(dicomDate(date), dicomDate(at));
  return `${shown}${note}`;
}

/** 端末の時間帯での今日（画面の今日。画面を開いた日にも使う） */
export function localToday(now = new Date()): SimpleDate {
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}

/**
 * 時刻（ISO 8601。時間帯の印が要る：`Z` か `+09:00`）を、時間帯 timeZone の `2026/10/20 05:49` の形にする
 * （時は0で埋める。seconds で秒も出す）。画面の日時の書式は、この1つにまとめる（docs/spec.md の 2.2）。
 * 時間帯の印の無い値は、どの時間帯の時刻か分からないので出さない（空）。読めなければ空。
 */
export function formatDateTimeIn(iso: unknown, timeZone: string, { seconds = false }: { seconds?: boolean } = {}): string {
  if (typeof iso !== "string" || !/(Z|[+-]\d{2}:\d{2})$/.test(iso)) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
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
  const time = `${parts.hour}:${parts.minute}${seconds ? `:${parts.second}` : ""}`;
  return `${parts.year}/${parts.month}/${parts.day} ${time}`;
}
