// 氏名（PatientName、VR は PN）を、画面に出す2つの値に分ける（docs/spec.md の 3.1）。
// 規則と試験の形は docs/patient-name-test-cases.md と tests/fixtures/patient-names.json（2つは同じ中身）。
// どんな入力でも例外にしない。読める字だけを出す。

export interface ParsedPatientName {
  /** 漢字の氏名。漢字の組が空ならローマ字の組。どちらも空なら空（かなを繰り上げない） */
  name: string;
  /** かなの氏名（かなの組だけ。ローマ字の組の値を移さない） */
  kana: string;
  /** ローマ字の組。画面に出さないときも検索に使う */
  alphabetic: string;
}

/** 半角カナ（U+FF61〜U+FF9F）の並び */
const HALF_WIDTH_KANA = /[｡-ﾟ]+/g;

/** 半角カナだけを全角にそろえる（濁点・半濁点は1字にまとめる）。ほかの字は変えない */
export function toFullWidthKana(value: string): string {
  return value.replace(HALF_WIDTH_KANA, (run) =>
    run
      .normalize("NFKC")
      // 前の字とまとまらなかった濁点・半濁点（結合の字）は、単独の字にする
      .replace(/゙/g, "゛")
      .replace(/゚/g, "゜"),
  );
}

/** 前後の空白（半角・全角・タブ）を落とし、中の空白の並びを半角の空白1つにする */
function tidySpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 氏名の成分の数（PS3.5 6.2：姓・名・ミドル・接頭・接尾） */
const COMPONENTS = 5;

/**
 * 1つの組（`姓^名^…`）を、1つの文字列にする。表示は姓と名だけ（`components` が 2）。
 * 検索は第3〜5成分（ミドル・接頭・接尾）まで含める（`components` が 5）
 */
function group(value: string | undefined, components = 2): string {
  if (!value) return "";
  return value
    .split("^")
    .slice(0, components)
    .map((part) => tidySpaces(toFullWidthKana(part)))
    .filter((part) => part !== "")
    .join(" ");
}

function parse(input: unknown, components: number): ParsedPatientName {
  const text = typeof input === "string" ? input : "";
  const [alphabeticRaw, ideographicRaw, phoneticRaw] = text.split("=");
  const alphabetic = group(alphabeticRaw, components);
  const ideographic = group(ideographicRaw, components);
  return {
    name: ideographic || alphabetic,
    kana: group(phoneticRaw, components),
    alphabetic,
  };
}

/** 画面に出す2つの値（姓と名だけ）と、ローマ字の組 */
export function parsePatientName(input: unknown): ParsedPatientName {
  return parse(input, 2);
}

/**
 * 検索にだけ使う値：parsePatientName と同じ組の選び方で、第3〜5成分（ミドル・接頭・接尾）まで含める。
 * 画面には出さない（表示は parsePatientName のまま。docs/patient-name-test-cases.md の規則 8）。
 * 組の選び方（漢字が空ならローマ字）は表示に合わせる。表示が空になる組は、検索でも使わない
 */
export function parsePatientNameForSearch(input: unknown): ParsedPatientName {
  const text = typeof input === "string" ? input : "";
  const [alphabeticRaw, ideographicRaw, phoneticRaw] = text.split("=");
  // 表示が空の組（第3成分以降だけの組を含む）は、検索でも空にする
  const searchable = (raw: string | undefined) => (group(raw, 2) ? group(raw, COMPONENTS) : "");
  const alphabetic = searchable(alphabeticRaw);
  return { name: searchable(ideographicRaw) || alphabetic, kana: searchable(phoneticRaw), alphabetic };
}
