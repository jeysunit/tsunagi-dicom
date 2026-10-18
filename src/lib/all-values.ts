import { personNameToString, type DicomJsonDataset } from "@/lib/backend/dicom-json";

// すべての DICOM の値（docs/spec.md 原則 8）。権限（dicom.all_values）があるときだけ返す画面の材料。
// 値は文字にして返し、画面はそのまま文字として出す（HTML として解かない）。

export interface DicomValueRow {
  /** `0010,0010` の形 */
  tag: string;
  vr: string;
  value: string;
}

const TAG_KEY = /^[0-9A-Fa-f]{8}$/;

function valueText(entry: NonNullable<DicomJsonDataset[string]>): string {
  if (entry.InlineBinary !== undefined || entry.BulkDataURI !== undefined) return "（バイナリ）";
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

/** DICOM JSON の1件を、タグの順の行にする。形の誤ったキーは落とす */
export function datasetRows(ds: DicomJsonDataset): DicomValueRow[] {
  return Object.keys(ds)
    .filter((k) => TAG_KEY.test(k) && ds[k] && typeof ds[k] === "object")
    .sort()
    .map((k) => {
      const entry = ds[k]!;
      const tag = k.toUpperCase();
      return { tag: `${tag.slice(0, 4)},${tag.slice(4)}`, vr: typeof entry.vr === "string" ? entry.vr : "", value: valueText(entry) };
    });
}
