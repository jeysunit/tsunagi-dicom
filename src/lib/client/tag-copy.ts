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

/** 1 行：`(0008,0020)<TAB>検査日<TAB>DA<TAB>20261024` */
export function tagRowText(row: CopyableTagRow): string {
  // 切って出した値は、表に見えているとおりに写す（全体の文字数を添え、切れていることが貼り付けの先で分かるようにする）
  const value = row.value === null ? "" : `${row.value}${row.length != null ? `…（全 ${row.length} 文字）` : ""}`;
  return [`(${row.tag})`, row.name ?? "", row.vr, value].map(cell).join("\t");
}

/** 複数の行：1 行ずつ改行でつなぐ。末尾に改行は付けない */
export function tagRowsText(rows: readonly CopyableTagRow[]): string {
  return rows.map(tagRowText).join("\n");
}
