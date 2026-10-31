// 患者・検査の値の修正（docs/spec.md の 3.5。段 6）で直せる項目と、値の形の確かめ。画面と BFF の両方で使う。
// 値の修正は2種類に分ける（openspec/changes/add-study-value-correction/design.md の 1）。
// - 属性の訂正（attribute）：患者 ID・氏名・生年月日・性別・受付番号。UID を保つ。直す範囲で3つに分ける。
//   - patient：氏名・生年月日・性別。同じ患者 ID の全部の検査に当てる
//   - reassign：患者 ID の付け替え。選んだ1つの検査だけ（氏名・生年月日・性別を添えてよい。替え先の患者があれば、その値にそろえる）
//   - accession：受付番号。選んだ1つの検査だけ
// - 中身の訂正（content）：検査日・検査名。新しい UID の検査を作る。
// 1つの要求に2種類を混ぜない。属性の訂正の中でも、範囲の違う項目を混ぜない（直す範囲を1つに決めるため）。
// 画面の呼び名は、属性の訂正が「患者情報修正」、中身の訂正が「検査情報修正」（docs/spec.md の 2.2）。

import { BIRTH_FORMAT_ERROR, parseBirthInput, type SimpleDate } from "@/lib/format/japanese-date";

export const ATTRIBUTE_FIELDS = ["PatientID", "PatientName", "PatientBirthDate", "PatientSex", "AccessionNumber"] as const;
export const CONTENT_FIELDS = ["StudyDate", "StudyDescription"] as const;
export const CORRECTION_FIELDS = [...ATTRIBUTE_FIELDS, ...CONTENT_FIELDS] as const;
export type AttributeField = (typeof ATTRIBUTE_FIELDS)[number];
export type ContentField = (typeof CONTENT_FIELDS)[number];
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];
export type CorrectionKind = "attribute" | "content";
export type CorrectionScope = "patient" | "reassign" | "accession" | "content";
export type CorrectionValues = Partial<Record<CorrectionField, string>>;

const PATIENT_FIELDS: readonly CorrectionField[] = ["PatientName", "PatientBirthDate", "PatientSex"];

export const isCorrectionField = (v: string): v is CorrectionField => (CORRECTION_FIELDS as readonly string[]).includes(v);

/** 文字の誤り（画面に出す文言と、どの項目か） */
export interface FieldProblem {
  field: CorrectionField | null;
  message: string;
}

/** 画面の項目の名前（docs/spec.md の 2.2） */
export const FIELD_LABELS: Record<CorrectionField, string> = {
  PatientID: "患者ID",
  PatientName: "氏名",
  PatientBirthDate: "生年月日",
  PatientSex: "性別",
  AccessionNumber: "受付番号",
  StudyDate: "検査日",
  StudyDescription: "検査名",
};

/** DA（YYYYMMDD）として正しい日付か（PS3.5 6.2） */
export function isDicomDate(v: string): boolean {
  if (!/^\d{8}$/.test(v)) return false;
  const y = Number(v.slice(0, 4));
  const m = Number(v.slice(4, 6));
  const d = Number(v.slice(6, 8));
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 1 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** 文字の数（PS3.5 6.2 の長さは文字の数。サロゲートの組は1文字に数える） */
const chars = (v: string) => [...v].length;
/**
 * 受けない文字：制御文字（PS3.5 6.1.2。ESC は文字の集合の切り替えに使うが、画面からは受けない）と、文字の向きを変える印
 * （画面と記録で、見えている並びと値の並びを違えるため。hl7-receiver/visible.ts が見える形にする文字と同じ）
 */
function isRefusedChar(c: number): boolean {
  return c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x061c || c === 0x200e || c === 0x200f
    || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
}
const hasRefusedChar = (v: string) => [...v].some((ch) => isRefusedChar(ch.codePointAt(0)!));

/**
 * 1つの値の形を確かめる（PS3.5 6.2）。問題が無ければ null。空の文字列は「値を空にする」で、患者 ID のほかは受ける
 * （氏名・生年月日・性別・受付番号・検査日は Type 2。検査名は Type 3）
 */
export function checkFieldValue(field: CorrectionField, value: string): string | null {
  const label = FIELD_LABELS[field];
  if (hasRefusedChar(value)) return `${label}に使えない文字が入っています`;
  if (value.includes("\\")) return `${label}に「\\」は使えません`;
  switch (field) {
    case "PatientID":
      // LO：64 文字まで。空にしない（検査を患者に結べなくなる）。前後の空白は値に数えないので受けない。検索の記号も受けない
      if (value === "") return "患者IDは空にできません";
      if (value !== value.trim()) return "患者IDの前後に空白は入れられません";
      if (/[*?]/.test(value)) return "患者IDに「*」「?」は使えません";
      return chars(value) > 64 ? "患者IDは64文字までです" : null;
    case "PatientName": {
      // PN：「=」で区切った組は3つまで（英字・漢字・かな）、組ごとに 64 文字まで、「^」で区切った部分は5つまで
      const groups = value.split("=");
      if (groups.length > 3) return "氏名の「=」の区切りは3つまでです";
      if (groups.some((g) => chars(g) > 64)) return "氏名は組ごとに64文字までです";
      if (groups.some((g) => g.split("^").length > 5)) return "氏名の「^」の区切りは5つまでです";
      return null;
    }
    case "PatientBirthDate":
      // 和暦などの入力は、先に readBirthValue で YYYYMMDD にしてから確かめる
      return value === "" || isDicomDate(value) ? null : BIRTH_FORMAT_ERROR;
    case "StudyDate":
      return value === "" || isDicomDate(value) ? null : `${label}は YYYYMMDD の8桁の日付で入力してください`;
    case "PatientSex":
      // U は画面と製品の中の値で、DICOM に書くときは空になる（normalizeCorrectionValues）。Patient's Sex の列挙値は M・F・O だけ（PS3.3 C.7.1.1）
      return ["", "M", "F", "O", "U"].includes(value) ? null : "性別は M・F・O・U のどれかです";
    case "AccessionNumber":
      return chars(value) > 16 ? "受付番号は16文字までです" : null;
    case "StudyDescription":
      return chars(value) > 64 ? "検査名は64文字までです" : null;
  }
}

/**
 * 種類と項目から、直す範囲を決める。項目が無い・種類と合わない・2種類を混ぜた・範囲の違う属性を混ぜたときは、
 * 問題を返す（BFF は 400 で断る）
 */
export function correctionScope(kind: CorrectionKind, values: CorrectionValues): { scope: CorrectionScope } | { problem: FieldProblem } {
  const fields = Object.keys(values).filter(isCorrectionField);
  if (fields.length === 0) return { problem: { field: null, message: "修正する項目がありません" } };
  const attrs = fields.filter((f) => (ATTRIBUTE_FIELDS as readonly string[]).includes(f));
  const contents = fields.filter((f) => (CONTENT_FIELDS as readonly string[]).includes(f));
  if (attrs.length > 0 && contents.length > 0) {
    return { problem: { field: null, message: "患者情報と検査情報は、別々に修正してください" } };
  }
  if (kind === "content") {
    return contents.length > 0 ? { scope: "content" } : { problem: { field: null, message: "検査情報修正で修正できるのは、検査日と検査名です" } };
  }
  if (attrs.length === 0) return { problem: { field: null, message: "患者情報修正で修正できるのは、患者ID・氏名・生年月日・性別・受付番号です" } };
  if (attrs.includes("AccessionNumber")) {
    return attrs.length === 1 ? { scope: "accession" } : { problem: { field: null, message: "受付番号は、ほかの項目と別に修正してください" } };
  }
  if (attrs.includes("PatientID")) return { scope: "reassign" };
  return attrs.every((f) => PATIENT_FIELDS.includes(f)) ? { scope: "patient" } : { problem: { field: null, message: "修正できない項目があります" } };
}

/**
 * 生年月日の値を読み取り、DICOM の DA（YYYYMMDD）にする（docs/spec.md の 3.1「生年月日の入力」）。空は「値を空にする」でそのまま。
 * API の値は YYYYMMDD で、画面の入力と同じ形（`S50/05/14`・`昭和50年5月14日` など）も受ける。どちらも画面と同じ読み取り
 * （形 → 元号の範囲 → 今日より後）で確かめ、同じ文で断る。today はサーバーの時間帯（TZ）の今日
 */
export function readBirthValue(value: string, today: SimpleDate): { ok: true; da: string } | { ok: false; message: string } {
  if (value === "") return { ok: true, da: "" };
  const da = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  const read = parseBirthInput(da ? `${da[1]}/${da[2]}/${da[3]}` : value, today);
  return read.ok ? { ok: true, da: read.da } : read;
}

/**
 * 直す値を DICOM に書く形にそろえる（確かめの画面と実行の両方で、形を確かめる前に通す）。
 * 生年月日は YYYYMMDD にし、読めなければ問題を返す。性別の U（不明）は空にする（Patient's Sex の列挙値は M・F・O だけ）
 */
export function normalizeCorrectionValues(values: CorrectionValues, today: SimpleDate): { values: CorrectionValues } | { problem: FieldProblem } {
  let out = values;
  if (values.PatientSex === "U") out = { ...out, PatientSex: "" };
  const birth = values.PatientBirthDate;
  if (typeof birth !== "string") return { values: out };
  const read = readBirthValue(birth, today);
  if (!read.ok) return { problem: { field: "PatientBirthDate", message: read.message } };
  return { values: { ...out, PatientBirthDate: read.da } };
}

/** 全部の項目の値の形を確かめる。最初の問題を返す */
export function checkCorrectionValues(values: CorrectionValues): FieldProblem | null {
  for (const [field, value] of Object.entries(values)) {
    if (!isCorrectionField(field)) return { field: null, message: "修正できない項目があります" };
    if (typeof value !== "string") return { field, message: `${FIELD_LABELS[field]}の値が正しくありません` };
    const message = checkFieldValue(field, value);
    if (message) return { field, message };
  }
  return null;
}
