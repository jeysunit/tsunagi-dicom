import type { StudyQuery } from "@/lib/backend/types";
import type { StudyView } from "@/lib/fields";
import type { SimpleDate } from "@/lib/format/japanese-date";
import { parseDicomDate } from "@/lib/format/japanese-date";
import { orderGroups, parseGroups, studyInGroup, type ModalityGroup } from "@/lib/modalities";

// 検査の一覧のすぐ絞れる見出し（docs/spec.md の 3.1）。
// 検査日：今日・昨日・1週間・今月・全期間・期間の指定。モダリティ。横断の検索。
// 検査の状態の見出し（未検像・検像済・未読・既読・緊急・ブックマーク）は持たない（docs/spec.md の 0）。
// 絞り込みの値は頁の URL（?date=…）に持ち、BFF の画面の API にも同じ形で渡す。
// 検査日と詳細条件（生年月日・性別・受付番号・検査名。2026-10-21）は画像サーバーの QIDO-RS の条件にし、
// モダリティと横断の検索は BFF で、役割の許可の一覧で絞った後の項目に当てる（許可されていない項目では探せない。
// 詳細条件も、許可の一覧に載っていない項目の条件は効かせない）。

export const DATE_PRESETS = ["today", "yesterday", "week", "month", "all", "range"] as const;
export type DatePreset = (typeof DATE_PRESETS)[number];
/** 画面の言葉（docs/spec.md の 2.2 の用語集） */
export const DATE_LABELS: Record<DatePreset, string> = {
  today: "今日",
  yesterday: "昨日",
  week: "過去7日",
  month: "今月",
  all: "すべて",
  range: "期間指定",
};

/** 件数を添える検査日の見出し（期間の指定には添えない） */
export const FACET_DATES = ["today", "yesterday", "week", "month", "all"] as const;
export type FacetDate = (typeof FACET_DATES)[number];

/**
 * 見出しごとの件数（BFF が数える）。各見出しの件数は「それを押したあとの一覧の件数」と同じ
 * （ほかの見出しと横断の検索は、いまの値のまま）。役割の許可の一覧に載っていない項目の見出しは、キーごと無い
 */
export interface StudyFacets {
  date?: Partial<Record<FacetDate, number>>;
  modality?: { all: number } & Partial<Record<ModalityGroup, number>>;
  /**
   * 件数が「以上」（検索の上限に届いて、数えきれていない）のもの。ここに無い件数は確定で、押したあとの一覧の件数と同じ。
   * list：モダリティの件数（いまの一覧が上限に届いた）。date：上限に届いた全期間の検索で、範囲がすべて入っていない検査日の見出し
   */
  atLeast?: { list?: boolean; date?: FacetDate[] };
}

/** 横断の検索の語の長さの上限 */
export const MAX_QUERY_LENGTH = 100;

export interface StudyFilter {
  date: DatePreset;
  /** 期間の指定（`YYYY-MM-DD`）。date が range のときだけ使う */
  from?: string;
  to?: string;
  /** 選んだモダリティの群（複数選べる。どれかに合えば合う。見出しの順。無ければ絞らない） */
  modalities?: ModalityGroup[];
  q?: string;
  // ── 詳細条件（docs/spec.md の 3.1。2026-10-21）。Orthanc の QIDO-RS の条件にする ──
  /** 生年月日（`YYYY-MM-DD`）。一致 */
  birth?: string;
  /** 性別（M・F・O）。一致 */
  sex?: PatientSex;
  /** 受付番号・検査名。値を含むもの */
  accession?: string;
  desc?: string;
}

export const PATIENT_SEX = ["M", "F", "O"] as const;
export type PatientSex = (typeof PATIENT_SEX)[number];

/** 詳細条件の文字の欄の長さの上限（受付番号は SH の 16 字、検査名は LO の 64 字） */
export const MAX_FIELD_LENGTH = 64;

/**
 * 詳細条件の文字の欄で受けない字：制御文字と、QIDO-RS の値で特別の意味を持つ字（ワイルドカードの `*` `?`、
 * 値の区切りの `\`、UID の並びの `,`）。含む値は条件にしない（Orthanc へ渡す値を、ワイルドカードとして解かせない）
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_FIELD_CHARS = /[\u0000-\u001f\u007f*?\\,]/;

/** 詳細条件の文字の欄を読む。前後の空白を除き、空・長すぎる・受けない字を含む値は条件にしない */
export function fieldValue(value: string | undefined): string | undefined {
  const v = value?.trim();
  if (!v || v.length > MAX_FIELD_LENGTH || FORBIDDEN_FIELD_CHARS.test(v)) return undefined;
  return v;
}

/** 詳細条件（期間指定を除く）の URL の名前と、許可の一覧の項目（項目が許されていない役割には効かせない） */
export const ADVANCED_KEYS = [
  ["birth", "patientBirthDate"],
  ["sex", "patientSex"],
  ["accession", "accessionNumber"],
  ["desc", "studyDescription"],
] as const satisfies readonly (readonly [keyof StudyFilter, keyof StudyView])[];

/** 既定は全期間（段 1 の一覧と同じ見え方。新しい順に上限まで） */
export const DEFAULT_FILTER: StudyFilter = { date: "all" };

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function param(params: Params, key: string): string | undefined {
  const v = params instanceof URLSearchParams ? params.get(key) : params[key];
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === "string" ? one : undefined;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
function isoDate(value: string | undefined): string | undefined {
  const m = value ? ISO_DATE.exec(value) : null;
  return m && parseDicomDate(`${m[1]}${m[2]}${m[3]}`) ? value : undefined;
}

/** URL の値を読む。読めない値は使わない（既定にする） */
export function parseFilter(params: Params): StudyFilter {
  const date = param(params, "date");
  const modality = param(params, "modality");
  const q = param(params, "q")?.trim().slice(0, MAX_QUERY_LENGTH);
  const filter: StudyFilter = { date: (DATE_PRESETS as readonly string[]).includes(date ?? "") ? (date as DatePreset) : "all" };
  if (filter.date === "range") {
    const from = isoDate(param(params, "from"));
    const to = isoDate(param(params, "to"));
    if (from) filter.from = from;
    if (to) filter.to = to;
  }
  const modalities = parseGroups(modality);
  if (modalities.length > 0) filter.modalities = modalities;
  if (q) filter.q = q;
  const birth = isoDate(param(params, "birth"));
  if (birth) filter.birth = birth;
  const sex = param(params, "sex");
  if ((PATIENT_SEX as readonly string[]).includes(sex ?? "")) filter.sex = sex as PatientSex;
  for (const key of ["accession", "desc"] as const) {
    const v = fieldValue(param(params, key));
    if (v) filter[key] = v;
  }
  return filter;
}

/** 詳細条件（期間指定を除く）で絞っている数（「詳細条件」のボタンに添える） */
export function advancedCount(filter: StudyFilter): number {
  return ADVANCED_KEYS.filter(([key]) => !!filter[key]).length;
}

/**
 * 付いている詳細条件のうち、許可の一覧に載っていない項目のもの（URL の名前）。
 * これがあれば、一覧は条件を外して広げずに 0 件にする（study-list.ts。隠した項目で探せないように。原則 8）
 */
export function blockedConditions(filter: StudyFilter, fields: readonly string[]): string[] {
  return ADVANCED_KEYS.filter(([key, field]) => !!filter[key] && !fields.includes(field)).map(([key]) => key);
}

/**
 * 詳細条件を、画像サーバーへ渡す条件にする。許可の一覧に載っていない項目の条件は渡さない
 * （そのときは blockedConditions があるので、一覧は 0 件にする）
 */
export function advancedQuery(filter: StudyFilter, fields: readonly string[]): StudyQuery {
  const q: StudyQuery = {};
  const allowed = (field: string) => fields.includes(field);
  if (filter.birth && allowed("patientBirthDate")) q.patientBirthDate = filter.birth.replaceAll("-", "");
  if (filter.sex && allowed("patientSex")) q.patientSex = filter.sex;
  if (filter.accession && allowed("accessionNumber")) q.accessionNumber = filter.accession;
  if (filter.desc && allowed("studyDescription")) q.studyDescription = filter.desc;
  return q;
}

/** 頁の URL・画面の API の query にする（既定の値は書かない） */
export function filterToSearchParams(filter: StudyFilter): URLSearchParams {
  const out = new URLSearchParams();
  if (filter.date !== "all") out.set("date", filter.date);
  if (filter.date === "range") {
    if (filter.from) out.set("from", filter.from);
    if (filter.to) out.set("to", filter.to);
  }
  if (filter.modalities?.length) out.set("modality", orderGroups(filter.modalities).join(","));
  if (filter.q) out.set("q", filter.q);
  for (const [key] of ADVANCED_KEYS) {
    const v = filter[key];
    if (v) out.set(key, v);
  }
  return out;
}

/** 時間帯（TZ）での今日 */
export function todayIn(timeZone: string, now = new Date()): SimpleDate {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day") };
}

const dicomDate = (d: SimpleDate) => `${d.year}${String(d.month).padStart(2, "0")}${String(d.day).padStart(2, "0")}`;
function addDays(d: SimpleDate, days: number): SimpleDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** 検査日の見出しを、画像サーバーへ渡す範囲（YYYYMMDD）にする。1週間は今日を含む7日 */
export function dateQuery(filter: StudyFilter, today: SimpleDate): StudyQuery {
  const t = dicomDate(today);
  switch (filter.date) {
    case "today":
      return { dateFrom: t, dateTo: t };
    case "yesterday": {
      const y = dicomDate(addDays(today, -1));
      return { dateFrom: y, dateTo: y };
    }
    case "week":
      return { dateFrom: dicomDate(addDays(today, -6)), dateTo: t };
    case "month":
      return { dateFrom: dicomDate({ ...today, day: 1 }), dateTo: t };
    case "range": {
      const q: StudyQuery = {};
      if (filter.from) q.dateFrom = filter.from.replaceAll("-", "");
      if (filter.to) q.dateTo = filter.to.replaceAll("-", "");
      return q;
    }
    case "all":
      return {};
  }
}

/** 検索のために字をそろえる：NFKC・小文字・カタカナをひらがなに・空白を除く */
export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/\s+/g, "");
}

/** 横断の検索に使う項目（患者 ID・氏名の漢字・かな・英字・受付番号・検査の記述） */
const SEARCH_FIELDS = [
  "patientId",
  "patientName",
  "patientKana",
  "patientNameAlphabetic",
  "accessionNumber",
  "studyDescription",
] as const satisfies readonly (keyof StudyView)[];

/**
 * 許可の一覧で絞った後の1行が、モダリティ・横断の検索に合うか。
 * 項目が許可されていない（view に無い）ときは、その項目では合わない（隠した項目では探せない）
 */
export function matchesFilter(view: StudyView, filter: StudyFilter): boolean {
  // 選んだ群のどれかに合えば合う（複数選んだときは「または」）
  const groups = filter.modalities ?? [];
  if (groups.length > 0 && !(view.modalities && groups.some((g) => studyInGroup(view.modalities!, g)))) return false;
  if (filter.q) {
    const needle = normalizeForSearch(filter.q);
    if (needle && !SEARCH_FIELDS.some((k) => typeof view[k] === "string" && normalizeForSearch(view[k]).includes(needle))) {
      return false;
    }
  }
  return true;
}
