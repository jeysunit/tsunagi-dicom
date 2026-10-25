// DICOM タグの表で選んだ行を、写す文字にする。1 行が 1 タグ：「(0008,0020)」「タグ名」「VR」「値」をタブで区切る。
// 複数の行は改行でつなぐ。表計算の貼り付けでそのまま列に分かれる。

export interface CopyableTagRow {
  /** 表に出す形（0008,0020） */
  tag: string;
  name?: string;
  vr: string;
  /** 値が無いタグは null（空の欄にする） */
  value: string | null;
  /** 値を切って出したときの、全体の文字数 */
  length?: number;
}

/** 欄の中のタブと改行は、行と列の区切りと混ざらないよう空白 1 つにする */
function cell(text: string): string {
  return text.replace(/[\t\r\n]+/g, " ");
}

/** 写す形式：全部の列（タグ・タグ名・VR・値）・タグと値・値だけ */
export type CopyFormat = "all" | "tag-value" | "value";

/** 1 行：全部の列なら `(0008,0020)<TAB>検査日<TAB>DA<TAB>20261024`、タグと値なら `(0008,0020)<TAB>20261024`、値だけなら `20261024` */
export function tagRowText(row: CopyableTagRow, format: CopyFormat = "all"): string {
  // 切って出した値は、表に見えているとおりに写す（全体の文字数を添え、切れていることが貼り付けの先で分かるようにする）
  const value = row.value === null ? "" : `${row.value}${row.length != null ? `…（全 ${row.length} 文字）` : ""}`;
  const tag = `(${row.tag})`;
  const columns = format === "all" ? [tag, row.name ?? "", row.vr, value] : format === "tag-value" ? [tag, value] : [value];
  return columns.map(cell).join("\t");
}

/** 複数の行：1 行ずつ改行でつなぐ。末尾に改行は付けない */
export function tagRowsText(rows: readonly CopyableTagRow[], format: CopyFormat = "all"): string {
  return rows.map((row) => tagRowText(row, format)).join("\n");
}
