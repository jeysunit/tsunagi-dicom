// 日付・和暦・年齢・性別の整形（docs/spec.md の 3.1）。
// 生年月日は `1975/05/10（昭和50年・51歳・男）` の形にする。年齢は検査日の時点で数える。
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

/** DICOM の TM（`HHMMSS.FFFFFF`）を `09:30` にする。読めなければ空 */
export function formatDicomTime(value: unknown): string {
  if (typeof value !== "string") return "";
  const m = /^(\d{2}):?(\d{2})/.exec(value.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
  return `${m[1]}:${m[2]}`;
}

/** 年号と、その始まりの日（改元の日。グレゴリオ暦） */
export const ERAS = [
  { name: "令和", start: { year: 2019, month: 5, day: 1 } },
  { name: "平成", start: { year: 1989, month: 1, day: 8 } },
  { name: "昭和", start: { year: 1926, month: 12, day: 25 } },
  { name: "大正", start: { year: 1912, month: 7, day: 30 } },
  { name: "明治", start: { year: 1868, month: 10, day: 23 } },
] as const;

function compare(a: SimpleDate, b: SimpleDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/** 和暦（`昭和50年`。1年は `令和元年`）。明治より前は空 */
export function toWareki(date: SimpleDate): string {
  const era = ERAS.find((e) => compare(date, e.start) >= 0);
  if (!era) return "";
  const year = date.year - era.start.year + 1;
  return `${era.name}${year === 1 ? "元" : year}年`;
}

/** `at` の日の時点の満年齢。誕生日の前日までは前の歳（2月29日生まれは、平年は3月1日に歳を取る）。生まれる前なら null */
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

/**
 * 生年月日・和暦・年齢・性別を1行にする：`1975/05/10（昭和50年・51歳・男）`。
 * 年齢は検査日の時点（検査日が読めなければ出さない）。出せない部分は飛ばし、何も無ければ空。
 */
export function formatBirthLine(birthDate: unknown, sex: unknown, studyDate: unknown): string {
  const birth = parseDicomDate(birthDate);
  const at = parseDicomDate(studyDate);
  const parts: string[] = [];
  if (birth) {
    const wareki = toWareki(birth);
    if (wareki) parts.push(wareki);
    const age = at ? ageAt(birth, at) : null;
    if (age !== null) parts.push(`${age}歳`);
  }
  const sexText = sexLabel(sex);
  if (sexText) parts.push(sexText);
  const head = birth ? formatSlashDate(birthDate) : "";
  if (parts.length === 0) return head;
  return `${head}（${parts.join("・")}）`;
}
