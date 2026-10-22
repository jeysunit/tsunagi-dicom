import { personNameToString, type DicomJsonDataset } from "@/lib/backend/dicom-json";
import { displayTag, tagName } from "@/lib/instance-tags";

// すべての DICOM の値（docs/spec.md 原則 8）。権限（dicom.all_values）があるときだけ返す画面の材料。
// 値は文字にして返し、画面はそのまま文字として出す（HTML として解かない）。

export interface DicomValueRow {
  /** `0010,0010` の形 */
  tag: string;
  vr: string;
  value: string;
  /** 値が VALUE_MAX_CHARS を超えて切ったときだけ、全体の文字数 */
  length?: number;
}

/** 画像ごとの「主なタグ」の1行（docs/spec.md の 3.1）。画像に無いタグは vr が空・value が null */
export interface InstanceTagRow {
  /** `0008,0018` の形 */
  tag: string;
  /** タグ名（日本語。表に無ければ空。src/lib/instance-tags.ts） */
  name: string;
  vr: string;
  value: string | null;
  /** 値が VALUE_MAX_CHARS を超えて切ったときだけ、全体の文字数 */
  length?: number;
}

/** 画面の API が返す 1 つの値の文字の上限（Unicode の符号位置で数える。超えた分は切り、全体の文字数を添える） */
export const VALUE_MAX_CHARS = 1024;

const TAG_KEY = /^[0-9A-Fa-f]{8}$/;
/** 中身を返さない VR（バイナリ） */
const BINARY_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "UN"]);

function valueText(entry: NonNullable<DicomJsonDataset[string]>): string {
  // バイナリの値は中身を返さない（BulkDataURI を読みに行かない）
  if (entry.InlineBinary !== undefined || entry.BulkDataURI !== undefined || BINARY_VR.has(entry.vr ?? "")) return "（バイナリ）";
  const values = entry.Value ?? [];
  if (entry.vr === "SQ") return `（シーケンス ${values.length} 件）`;
  return values
    .map((v) => {
      if (v === null || v === undefined) return "";
      if (typeof v === "object") {
        return "Alphabetic" in v || "Ideographic" in v || "Phonetic" in v
          ? personNameToString(v as { Alphabetic?: string; Ideographic?: string; Phonetic?: string })
          : "";
      }
      return String(v);
    })
    .join("\\");
}

/** 値の文字。VALUE_MAX_CHARS を超えたら先頭だけにし、全体の文字数を添える（サロゲートの組を割らない） */
function limitedValue(entry: NonNullable<DicomJsonDataset[string]>): { value: string; length?: number } {
  const chars = Array.from(valueText(entry));
  return chars.length > VALUE_MAX_CHARS ? { value: chars.slice(0, VALUE_MAX_CHARS).join(""), length: chars.length } : { value: chars.join("") };
}

/** DICOM JSON の1件を、タグの順の行にする。形の誤ったキーは落とす。長い値は切る（limitedValue） */
export function datasetRows(ds: DicomJsonDataset): DicomValueRow[] {
  return Object.keys(ds)
    .filter((k) => TAG_KEY.test(k) && ds[k] && typeof ds[k] === "object")
    .sort()
    .map((k) => {
      const entry = ds[k]!;
      const tag = k.toUpperCase();
      return { tag: displayTag(tag), vr: typeof entry.vr === "string" ? entry.vr : "", ...limitedValue(entry) };
    });
}

/**
 * 設定のタグだけを、設定の順に選び出す（設定に無いタグは返さない）。tags は 8 桁の大文字の 16 進。
 * 長い値は先頭の VALUE_MAX_CHARS 文字にし、全体の文字数を length に添える（サロゲートの組を割らない）
 */
export function instanceTagRows(ds: DicomJsonDataset, tags: readonly string[]): InstanceTagRow[] {
  const byTag = new Map<string, NonNullable<DicomJsonDataset[string]>>();
  for (const k of Object.keys(ds)) {
    const entry = ds[k];
    if (TAG_KEY.test(k) && entry && typeof entry === "object") byTag.set(k.toUpperCase(), entry);
  }
  return tags.map((tag) => {
    const row: InstanceTagRow = { tag: displayTag(tag), name: tagName(tag), vr: "", value: null };
    const entry = byTag.get(tag);
    if (!entry) return row;
    return { ...row, vr: typeof entry.vr === "string" ? entry.vr : "", ...limitedValue(entry) };
  });
}
