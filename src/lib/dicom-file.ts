// インポート（docs/spec.md の 3.5「取り込み」）で、Orthanc へ渡す前に DICOM のファイルの形を確かめ、頭の値を読む。
// 画素は読まない（長さで読み飛ばす）。読むのは、DICOM のファイルの形（PS3.10 7.1：128 バイトの前置きの後に "DICM"）、
// File Meta Information（group 0002。PS3.10 7.1 で、いつも Explicit VR Little Endian）の転送構文と SOP Instance UID、
// データセットの SOP Instance UID (0008,0018)（File Meta と同じかを確かめる）・患者 ID (0010,0020)・StudyInstanceUID (0020,000D)。
// 監査の記録の「どの患者と検査に」を、Orthanc を呼ぶ前に残すため（3.5 の共通の決まり）と、結果不明を
// SOP Instance UID で照らすため。読めないファイルは Orthanc へ渡さずに断る。
// 読んだ値が、Orthanc（DCMTK）の読む値と食い違わないよう、形の崩れたファイルは断る：
// - File Meta Information の先頭は File Meta Information Group Length (0002,0000)（UL。PS3.10 7.1 の Table 7.1-1 で Type 1）。
//   その値が示す範囲だけを File Meta として読み、範囲の中の要素がちょうどその範囲で終わること、範囲の外（データセット）に
//   group 0002 の要素が無いことを確かめる。
// - File Meta とデータセットの最上位の要素は、タグの厳密な昇順で並ぶこと（同じタグを二度持たない。PS3.5 7.1）。
//   データセットは最後の要素まで確かめる（途中で読むのをやめると、後ろに置いた同じタグを Orthanc が読みうる）。
// - 読む値の要素は、長さが決まっていて、Explicit VR では決まった VR（PS3.6 の 6 章：UI・CS・LO）であること。
// それでも Orthanc の読みと食い違いうるので、取り込んだ後に Orthanc が保存した値と照らす（src/app/api/import/route.ts）。

export interface DicomFileHeader {
  transferSyntaxUid: string;
  sopInstanceUid: string;
  patientId: string;
  studyInstanceUid: string;
}

export class DicomFileError extends Error {
  constructor(
    readonly reason: "not_dicom" | "unsupported_transfer_syntax" | "malformed",
    message: string,
  ) {
    super(message);
    this.name = "DicomFileError";
  }
}

const IMPLICIT_LE = "1.2.840.10008.1.2";
// Deflated（データセットが圧縮される）と Big Endian（PS3.5 で廃止）は、頭を読めないので断る
const UNSUPPORTED = new Set(["1.2.840.10008.1.2.1.99", "1.2.840.10008.1.2.2"]);
// Explicit VR で長さが 4 バイトになる VR（PS3.5 7.1.2 の Table 7.1-1）
const LONG_VR = new Set(["OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV"]);
const UNDEFINED = 0xffffffff;
const ITEM = 0xfffee000;
const ITEM_END = 0xfffee00d;
const SEQUENCE_END = 0xfffee0dd;
const META_GROUP_LENGTH = 0x00020000;
const META_SOP_UID = 0x00020003;
const META_TRANSFER_SYNTAX = 0x00020010;
const CHARSET = 0x00080005;
const SOP_UID = 0x00080018;
const PATIENT_ID = 0x00100020;
const STUDY_UID = 0x0020000d;
/** 読む値の要素の VR（PS3.6 の 6 章）。Explicit VR で違う VR のものは断る */
const EXPECTED_VR: ReadonlyMap<number, string> = new Map([
  [META_SOP_UID, "UI"],
  [META_TRANSFER_SYNTAX, "UI"],
  [CHARSET, "CS"],
  [SOP_UID, "UI"],
  [PATIENT_ID, "LO"],
  [STUDY_UID, "UI"],
]);
/**
 * 入れ子の深さと、読む要素の数の上限（壊れたファイルで回り続けない）。要素の数は、長さが未定義のシーケンスの中の要素も数える。
 * フレームの多い画像（フレームごとの機能グループのシーケンス）でも足りる数にする
 */
const MAX_DEPTH = 16;
const MAX_ELEMENTS = 2_000_000;
const UID = /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/;

export const isUid = (v: string) => v.length <= 64 && UID.test(v) && v.includes(".");

const malformed = (message = "DICOM のファイルの形が正しくありません") => new DicomFileError("malformed", message);

/** 値の文字列の後ろの空白と NUL を除く（PS3.5 6.2：UI は NUL、ほかの文字列は空白で偶数の長さにそろえる） */
function text(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes).replace(/[\0 ]+$/, "");
}

/**
 * 患者 ID（LO）を、Specific Character Set (0008,0005) に合わせて読む（PS3.5 6.1）。ASCII だけならそのまま。
 * ISO_IR 192（UTF-8）と ISO_IR 100（Latin-1）のときだけ字に直し、ほかの文字の集合（ISO 2022 など）と読めないバイトは、
 * 字を取り違えないよう `\xNN` の形でバイトのまま残す（監査の記録で、Orthanc に入った値と照らせるように）
 */
function patientIdText(bytes: Uint8Array, charset: string): string {
  const printable = (b: number) => (b >= 0x20 && b < 0x7f) || b === 0;
  const escaped = () => Array.from(bytes, (b) => (printable(b) ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`)).join("");
  let value: string;
  // ISO 2022 の切り替え（ESC）は 7 ビットなので、表示できる ASCII の字だけのときに限って、そのまま読む
  if (bytes.every(printable)) value = String.fromCharCode(...bytes);
  else if (charset.split("\\").includes("ISO_IR 192")) {
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      value = escaped();
    }
  } else if (charset.split("\\")[0] === "ISO_IR 100") value = new TextDecoder("latin1").decode(bytes);
  else value = escaped();
  return value.replace(/[\0 ]+$/, "");
}

interface Element {
  tag: number;
  vr: string | null;
  start: number;
  length: number;
}

class Reader {
  private elements = 0;
  constructor(
    private readonly b: Uint8Array,
    private readonly view = new DataView(b.buffer, b.byteOffset, b.byteLength),
  ) {}
  need(pos: number, n: number) {
    if (pos < 0 || pos + n > this.b.byteLength) throw malformed();
  }
  u16(pos: number) {
    this.need(pos, 2);
    return this.view.getUint16(pos, true);
  }
  u32(pos: number) {
    this.need(pos, 4);
    return this.view.getUint32(pos, true);
  }
  tag(pos: number) {
    return ((this.u16(pos) << 16) >>> 0) + this.u16(pos + 2);
  }
  slice(pos: number, n: number) {
    this.need(pos, n);
    return this.b.subarray(pos, pos + n);
  }
  /** 1 つの要素の頭を読む。返すのは、値の始まり・値の長さ（未定義なら UNDEFINED）・VR（Implicit なら null） */
  element(pos: number, implicit: boolean): Element {
    if (++this.elements > MAX_ELEMENTS) throw malformed();
    const tag = this.tag(pos);
    // 項目と区切り（FFFE,xxxx）は、どの転送構文でも VR を持たない（PS3.5 7.5）
    if (implicit || tag >>> 16 === 0xfffe) return { tag, vr: null, start: pos + 8, length: this.u32(pos + 4) };
    const vr = String.fromCharCode(...this.slice(pos + 4, 2));
    if (!/^[A-Z]{2}$/.test(vr)) throw malformed();
    return LONG_VR.has(vr)
      ? { tag, vr, start: pos + 12, length: this.u32(pos + 8) }
      : { tag, vr, start: pos + 8, length: this.u16(pos + 6) };
  }
  /** 長さが未定義の値（シーケンス・項目）を、区切りの後まで読み飛ばす。返すのは区切りの後の位置 */
  skipUndefined(pos: number, implicit: boolean, end: number, depth: number): number {
    if (depth > MAX_DEPTH) throw malformed();
    for (;;) {
      const e = this.element(pos, implicit);
      if (e.tag === end) return e.start;
      pos = this.next(e, implicit, depth);
    }
  }
  /** 要素の次の位置 */
  next(e: Element, implicit: boolean, depth: number): number {
    if (e.length !== UNDEFINED) {
      this.need(e.start, e.length);
      return e.start + e.length;
    }
    if (e.tag === ITEM) return this.skipUndefined(e.start, implicit, ITEM_END, depth + 1);
    return this.skipUndefined(e.start, implicit, SEQUENCE_END, depth + 1);
  }
  /** 読む値の要素の値（長さが決まっていて、Explicit VR なら決まった VR であること） */
  value(e: Element): Uint8Array {
    const vr = EXPECTED_VR.get(e.tag);
    if (e.length === UNDEFINED || (e.vr !== null && vr !== undefined && e.vr !== vr)) throw malformed();
    return this.slice(e.start, e.length);
  }
}

/** DICOM のファイルの形を確かめ、頭の値を読む。DICOM でない・転送構文を読めない・形が壊れているときは DicomFileError を投げる */
export function readDicomFileHeader(bytes: Uint8Array): DicomFileHeader {
  if (bytes.byteLength < 132 || String.fromCharCode(...bytes.subarray(128, 132)) !== "DICM") {
    throw new DicomFileError("not_dicom", "DICOM のファイルではありません");
  }
  const r = new Reader(bytes);
  // File Meta Information（group 0002）は Explicit VR Little Endian。先頭は Group Length (0002,0000) で、その値が
  // 示す範囲（Group Length の要素の後から）だけが File Meta
  const groupLength = r.element(132, false);
  if (groupLength.tag !== META_GROUP_LENGTH || groupLength.vr !== "UL" || groupLength.length !== 4) {
    throw malformed("DICOM のファイルの File Meta Information Group Length (0002,0000) がありません");
  }
  const metaEnd = groupLength.start + 4 + r.u32(groupLength.start);
  r.need(groupLength.start + 4, metaEnd - groupLength.start - 4);
  let pos = groupLength.start + 4;
  let previous = META_GROUP_LENGTH;
  let transferSyntaxUid = "";
  let sopInstanceUid = "";
  while (pos < metaEnd) {
    const e = r.element(pos, false);
    if (e.tag >>> 16 !== 0x0002 || e.tag <= previous || e.length === UNDEFINED) throw malformed();
    previous = e.tag;
    if (e.tag === META_TRANSFER_SYNTAX) transferSyntaxUid = text(r.value(e));
    if (e.tag === META_SOP_UID) sopInstanceUid = text(r.value(e));
    pos = r.next(e, false, 0);
    if (pos > metaEnd) throw malformed("DICOM のファイルの File Meta Information の長さが合いません");
  }
  if (!isUid(transferSyntaxUid) || !isUid(sopInstanceUid)) throw malformed();
  if (UNSUPPORTED.has(transferSyntaxUid)) {
    throw new DicomFileError("unsupported_transfer_syntax", "この転送構文の DICOM のファイルは扱いません");
  }
  const implicit = transferSyntaxUid === IMPLICIT_LE;
  let patientId: string | null = null;
  let studyInstanceUid = "";
  let datasetSopInstanceUid = "";
  let charset = "";
  // データセットの最上位の要素を最後まで。タグの厳密な昇順（PS3.5 7.1）で、group 0002（File Meta の外に置いたもの）と
  // 項目・区切り（FFFE,xxxx）は最上位に置けない
  previous = -1;
  while (pos < bytes.byteLength) {
    if (bytes.byteLength - pos < 8) throw malformed();
    const e = r.element(pos, implicit);
    const group = e.tag >>> 16;
    if (group === 0x0002 || group === 0xfffe || e.tag <= previous) {
      throw malformed("DICOM のファイルのデータセットの要素の並びが正しくありません（重複・順の乱れ）");
    }
    previous = e.tag;
    if (e.tag === SOP_UID) datasetSopInstanceUid = text(r.value(e));
    if (e.tag === CHARSET) charset = text(r.value(e));
    if (e.tag === PATIENT_ID) patientId = patientIdText(r.value(e), charset);
    if (e.tag === STUDY_UID) studyInstanceUid = text(r.value(e));
    pos = r.next(e, implicit, 0);
  }
  if (!isUid(studyInstanceUid)) throw malformed();
  // File Meta Information の Media Storage SOP Instance UID は、データセットの SOP Instance UID と同じ値（PS3.10 7.1）。
  // 違えば、どの画像かを決められないので断る（記録と照らし合わせに、取り違えた UID を使わない）
  if (datasetSopInstanceUid !== sopInstanceUid) {
    throw malformed("DICOM のファイルの SOP Instance UID が一致しません");
  }
  return { transferSyntaxUid, sopInstanceUid, patientId: patientId ?? "", studyInstanceUid };
}
