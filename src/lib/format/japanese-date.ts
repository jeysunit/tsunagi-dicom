// 日付・和暦・年齢・性別の整形（docs/spec.md の 3.1）。
// 生年月日は西暦の後ろの括弧に、元号の漢字 1 字（一覧の表は英字 1 字）と年・満年齢を並べる：`1975/05/14（昭50・51歳）`。
// 年齢は検査日の時点で数える。DICOM・HL7・CSV・API の値は西暦のままで、和暦は画面の表示だけに使う。
// DICOM の DA（YYYYMMDD）を読む。読めない値は例外にせず、出せる部分だけを出す。

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

/** 元号の漢字 1 字・英字 1 字と、その始まりの日（改元の日。グレゴリオ暦）。新しい元号から先に並べる */
export const ERAS = [
  { kanji: "令", letter: "R", start: { year: 2019, month: 5, day: 1 } },
  { kanji: "平", letter: "H", start: { year: 1989, month: 1, day: 8 } },
  { kanji: "昭", letter: "S", start: { year: 1926, month: 12, day: 25 } },
  { kanji: "大", letter: "T", start: { year: 1912, month: 7, day: 30 } },
  { kanji: "明", letter: "M", start: { year: 1868, month: 10, day: 23 } },
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
