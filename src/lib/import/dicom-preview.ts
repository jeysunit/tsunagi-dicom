// インポートの画面（ファイルを選ぶ部品。docs/design-system/parts.md の「ファイルを選ぶ部品」）で、選んだファイルの先頭だけを
// ブラウザで読み、DICOM かどうかと、患者と検査の列に出す 6 つの値を取る。ブラウザの確認は目安で、
// 最終の確認は BFF（src/lib/dicom-file.ts と src/app/api/import/route.ts）が行う。
// - DICOM かどうか：128 バイトの前置きの後に "DICM"（PS3.10 の 7.1）。
// - 読む値：患者 ID (0010,0020)・氏名 (0010,0010)・検査日 (0008,0020)・モダリティ (0008,0060)・
//   シリーズ番号 (0020,0011)・インスタンス番号 (0020,0013)。読むのに要る転送構文 (0002,0010) と文字コード (0008,0005) も読む。
// - 読むのは先頭の 64 KB まで（HEAD_BYTES）で、データセットの (0020) の群を過ぎたら止める。画素は読まない。
// - 読めない値は空にする（画面は「—」）。化けた字は出さない（知らない文字コード・文字コードに合わないバイト）。
// 読んだ値はブラウザの中で出すだけで、記録・送信しない。

/** 1 つのファイルで読む先頭の大きさ（部品集の決まり） */
export const HEAD_BYTES = 65536;

export interface PreviewTags {
  patientId: string;
  /** 氏名の元の値（PN）。画面は src/lib/format/patient-name.ts で表示の形にする */
  patientName: string;
  /** 検査日。8 桁の DA のときだけ yyyy/MM/dd、ほかは空 */
  studyDate: string;
  modality: string;
  /** シリーズ番号（IS を整数に直した字）。読めなければ空 */
  seriesNumber: string;
  /** インスタンス番号（IS を整数に直した字）。読めなければ空 */
  instanceNumber: string;
}

export type HeadCheck =
  | { kind: "dicom"; tags: PreviewTags | null }
  | { kind: "excluded"; reason: string };

const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const UNDEFINED = 0xffffffff;
const IMPLICIT_LE = "1.2.840.10008.1.2";
// Big Endian（PS3.5 で廃止）と Deflated（データセットが圧縮される）は、頭を読めない
const UNREADABLE_SYNTAX = new Set(["1.2.840.10008.1.2.2", "1.2.840.10008.1.2.1.99"]);

const WANT: ReadonlyMap<number, keyof RawValues> = new Map([
  [0x00020010, "transferSyntax"],
  [0x00080005, "charset"],
  [0x00080020, "studyDate"],
  [0x00080060, "modality"],
  [0x00100010, "patientName"],
  [0x00100020, "patientId"],
  [0x00200011, "seriesNumber"],
  [0x00200013, "instanceNumber"],
]);

interface RawValues {
  transferSyntax?: Uint8Array;
  charset?: Uint8Array;
  studyDate?: Uint8Array;
  modality?: Uint8Array;
  patientName?: Uint8Array;
  patientId?: Uint8Array;
  seriesNumber?: Uint8Array;
  instanceNumber?: Uint8Array;
}

/** 入れ子の深さの上限（壊れたファイルで回り続けない） */
const MAX_DEPTH = 16;

class Unreadable extends Error {}

function ascii(bytes: Uint8Array | undefined): string {
  if (!bytes) return "";
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s.replace(/[\0 ]+$/, "").trim();
}

/**
 * データセットを歩いて、欲しい値を raw に入れる。最上位の (0020) の群を過ぎたら止める。
 * 戻り値は次に読む位置。読めない形（転送構文が読めない・入れ子が深すぎる）は Unreadable を投げる
 */
function walk(view: DataView, start: number, stop: number | null, depth: number, state: { explicit: boolean; meta: boolean; raw: RawValues }): number {
  if (depth > MAX_DEPTH) throw new Unreadable();
  const n = view.byteLength;
  let p = start;
  while (p + 8 <= n) {
    const group = view.getUint16(p, true);
    const element = view.getUint16(p + 2, true);
    if (group === 0xfffe) {
      const itemLength = view.getUint32(p + 4, true);
      if (element === stop) return p + 8;
      if (element === 0xe000) {
        p = itemLength === UNDEFINED ? walk(view, p + 8, 0xe00d, depth + 1, state) : p + 8 + itemLength;
        continue;
      }
      return p + 8;
    }
    if (state.meta && group !== 0x0002 && depth === 0) {
      state.meta = false;
      const syntax = ascii(state.raw.transferSyntax);
      if (UNREADABLE_SYNTAX.has(syntax)) throw new Unreadable();
      state.explicit = syntax !== IMPLICIT_LE;
    }
    if (depth === 0 && group > 0x0020) return n;
    let length: number;
    let header: number;
    if (group === 0x0002 || state.explicit) {
      const vr = String.fromCharCode(view.getUint8(p + 4), view.getUint8(p + 5));
      if (LONG_VR.has(vr)) {
        if (p + 12 > n) return n;
        length = view.getUint32(p + 8, true);
        header = 12;
      } else {
        length = view.getUint16(p + 6, true);
        header = 8;
      }
    } else {
      length = view.getUint32(p + 4, true);
      header = 8;
    }
    if (length === UNDEFINED) {
      p = walk(view, p + header, 0xe0dd, depth + 1, state);
      continue;
    }
    const key = WANT.get(((group << 16) | element) >>> 0);
    if (depth === 0 && key && p + header + length <= n) {
      state.raw[key] = new Uint8Array(view.buffer, view.byteOffset + p + header, length);
    }
    p += header + length;
  }
  return p;
}

type Decoder = "ascii" | "utf-8" | "latin1" | "jisx0201" | { iso2022: { katakanaG1: boolean } };

/**
 * 文字コード (0008,0005) から、患者 ID と氏名の読み方を決める（PS3.3 C.12.1.1.2・PS3.5 6.1）。知らない文字コードは null（読まない）。
 * - 値が 1 つ：ISO_IR 6（無いときも）・ISO_IR 192（UTF-8）・ISO_IR 100（Latin-1）・ISO_IR 13（JIS X 0201。ローマ字と半角カナ）
 * - コード拡張（ISO 2022 …）：日本語の ISO 2022 IR 6・IR 13・IR 87・IR 159 の組だけを読む（エスケープの列を下の iso2022Text が辿る）
 */
function decoderOf(charset: string): Decoder | null {
  const terms = charset.split("\\").map((t) => t.trim());
  if (terms.length === 1) {
    const t = terms[0]!;
    if (t === "" || t === "ISO_IR 6") return "ascii";
    if (t === "ISO_IR 192") return "utf-8";
    if (t === "ISO_IR 100") return "latin1";
    if (t === "ISO_IR 13") return "jisx0201";
  }
  const known = ["", "ISO 2022 IR 6", "ISO 2022 IR 13", "ISO 2022 IR 87", "ISO 2022 IR 159"];
  if (terms.some((t) => t.startsWith("ISO 2022")) && terms.every((t) => known.includes(t))) {
    // 1 つ目の値が IR 13 なら、初めから G1 に半角カナ（8 ビットの 0xA1〜0xDF）を置く
    return { iso2022: { katakanaG1: terms[0] === "ISO 2022 IR 13" } };
  }
  return null;
}

const halfKana = (b: number) => String.fromCharCode(0xff61 + (b - 0xa1));

/** JIS X 0201：0x00〜0x7F はローマ字（ASCII と読む）、0xA1〜0xDF は半角カナ。ほかのバイトは読まない */
function jisx0201Text(bytes: Uint8Array): string | null {
  let s = "";
  for (const b of bytes) {
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b >= 0xa1 && b <= 0xdf) s += halfKana(b);
    else return null;
  }
  return s;
}

/**
 * 日本語の ISO 2022（PS3.5 6.1.2.5・PS3.3 C.12.1.1.2 の表 C.12-4）。ESC ( B・ESC ( J は G0 を ASCII（ローマ字）に、ESC $ B・ESC $ @ は
 * G0 を JIS X 0208 に、ESC ) I は G1 を半角カナにする。区切り（^・=・\・CR・LF）で G0 は初めの ASCII に戻る（PS3.5 6.1.2.5.3）。
 * JIS X 0212（ESC $ ( D）と知らないエスケープ・合わないバイトは読まない（null）
 */
function iso2022Text(bytes: Uint8Array, katakanaG1Initial: boolean): string | null {
  let s = "";
  let g0: "ascii" | "kanji" = "ascii";
  let g1Katakana = katakanaG1Initial;
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    if (b === 0x1b) {
      const seq = Array.from(bytes.subarray(i + 1, i + 4));
      if (seq[0] === 0x28 && (seq[1] === 0x42 || seq[1] === 0x4a)) {
        g0 = "ascii";
        i += 3;
      } else if (seq[0] === 0x24 && (seq[1] === 0x42 || seq[1] === 0x40)) {
        g0 = "kanji";
        i += 3;
      } else if (seq[0] === 0x29 && seq[1] === 0x49) {
        g1Katakana = true;
        i += 3;
      } else {
        return null;
      }
      continue;
    }
    if (b >= 0x80) {
      if (!g1Katakana || b < 0xa1 || b > 0xdf) return null;
      s += halfKana(b);
      i++;
      continue;
    }
    if (g0 === "kanji" && b >= 0x21 && b <= 0x7e) {
      const b2 = bytes[i + 1];
      if (b2 === undefined || b2 < 0x21 || b2 > 0x7e) return null;
      try {
        s += new TextDecoder("iso-2022-jp", { fatal: true }).decode(Uint8Array.from([0x1b, 0x24, 0x42, b, b2, 0x1b, 0x28, 0x42]));
      } catch {
        return null;
      }
      i += 2;
      continue;
    }
    if ([0x5e, 0x3d, 0x5c, 0x0d, 0x0a].includes(b)) g0 = "ascii";
    s += String.fromCharCode(b);
    i++;
  }
  return s;
}

function textOf(bytes: Uint8Array | undefined, decoder: Decoder | null): string {
  if (!bytes || bytes.length === 0) return "";
  if (bytes.every((b) => b < 0x80 && b !== 0x1b)) return ascii(bytes);
  if (!decoder || decoder === "ascii") return "";
  let text: string | null;
  if (decoder === "latin1") {
    // ISO_IR 100（Latin-1）は 0x80〜0x9F を字に持たない（WHATWG の windows-1252 はこの範囲を別の字に読むので、読まない）
    text = bytes.some((b) => b >= 0x80 && b <= 0x9f) ? null : new TextDecoder("windows-1252").decode(bytes);
  } else if (decoder === "jisx0201") {
    text = jisx0201Text(bytes);
  } else if (decoder === "utf-8") {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = null;
    }
  } else {
    text = iso2022Text(bytes, decoder.iso2022.katakanaG1);
  }
  return text === null ? "" : text.replace(/[\0 ]+$/, "").trim();
}

/** IS（符号を含めて 12 文字まで、-2^31〜2^31-1 の整数）を、先頭の 0 と + を外した字にする。その形でなければ空 */
function integerString(bytes: Uint8Array | undefined): string {
  const v = ascii(bytes);
  if (v.length > 12 || !/^[+-]?\d+$/.test(v)) return "";
  const x = Number.parseInt(v, 10);
  return x >= -2147483648 && x <= 2147483647 ? String(x) : "";
}

/**
 * ファイルの先頭（HEAD_BYTES まで）から、患者と検査の列の値を読む。前置きと "DICM" は呼ぶ側が確認してから渡す。
 * 頭を読めない形（Big Endian・Deflated・壊れた入れ子）は null（列は全部「—」）
 */
export function readPreviewTags(head: Uint8Array): PreviewTags | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const state = { explicit: true, meta: true, raw: {} as RawValues };
  try {
    walk(view, 132, null, 0, state);
  } catch {
    return null;
  }
  const { raw } = state;
  const decoder = decoderOf(ascii(raw.charset));
  const date = ascii(raw.studyDate);
  return {
    patientId: textOf(raw.patientId, decoder),
    patientName: textOf(raw.patientName, decoder),
    studyDate: /^\d{8}$/.test(date) ? `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}` : "",
    modality: ascii(raw.modality),
    seriesNumber: integerString(raw.seriesNumber),
    instanceNumber: integerString(raw.instanceNumber),
  };
}

/** 大きさの表示（1,024 進み。1,024 B 未満は整数の B、KB・MB は小数 1 桁、GB は 2 桁） */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units: Array<[string, number, number]> = [
    ["KB", 1024, 1],
    ["MB", 1024 ** 2, 1],
    ["GB", 1024 ** 3, 2],
  ];
  for (let i = 0; i < units.length; i++) {
    const [unit, base, digits] = units[i]!;
    const shown = (bytes / base).toFixed(digits);
    // 丸めて 1,024 になるときは、次の単位で出す（「1024.0 KB」と出さない）。GB は上が無いのでそのまま
    if (i < units.length - 1 && Number(shown) >= 1024) continue;
    return `${Number(shown).toLocaleString("ja-JP", { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${unit}`;
  }
  return `${bytes} B`;
}

/** 件数の表示（3 桁区切り） */
export const formatCount = (n: number) => n.toLocaleString("ja-JP");

/**
 * 選んだファイルの大きさと先頭のバイトから、インポートに回すか（DICOM）、対象外か（理由の 1 句）を決める。
 * 上限との比べはバイトの実数で行う。丸めた表示が上限と同じに見える超過は、理由にバイト数を添える
 */
export function checkHead(head: Uint8Array, size: number, limitBytes: number): HeadCheck {
  if (size > limitBytes) {
    const limitLabel = `${formatCount(Math.round(limitBytes / 1024 ** 2))} MB`;
    const looksSame = formatSize(size) === formatSize(limitBytes);
    return { kind: "excluded", reason: `上限（${limitLabel}）を超えています${looksSame ? `（${formatCount(size)} B）` : ""}` };
  }
  if (size < 132 || head.length < 132 || ascii(head.subarray(128, 132)) !== "DICM") {
    return { kind: "excluded", reason: "DICOM ファイルではありません" };
  }
  return { kind: "dicom", tags: readPreviewTags(head) };
}

/** 読めなかった（ブラウザがファイルを読めない）ときの理由 */
export const UNREADABLE_REASON = "読めませんでした";
