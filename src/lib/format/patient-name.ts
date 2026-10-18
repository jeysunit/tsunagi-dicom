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

/** 1つの組（`姓^名^…`）を、姓と名だけの1つの文字列にする */
function group(value: string | undefined): string {
  if (!value) return "";
  const [family = "", given = ""] = value.split("^");
  return [family, given]
    .map((part) => tidySpaces(toFullWidthKana(part)))
    .filter((part) => part !== "")
    .join(" ");
}

export function parsePatientName(input: unknown): ParsedPatientName {
  const text = typeof input === "string" ? input : "";
  const [alphabeticRaw, ideographicRaw, phoneticRaw] = text.split("=");
  const alphabetic = group(alphabeticRaw);
  const ideographic = group(ideographicRaw);
  return {
    name: ideographic || alphabetic,
    kana: group(phoneticRaw),
    alphabetic,
  };
}
