// インポート（docs/spec.md の 3.5「取り込み」）で、Orthanc へ渡す前に DICOM のファイルの頭だけを読む。
// 画素は読まない。読むのは、DICOM のファイルの形（PS3.10 7.1：128 バイトの前置きの後に "DICM"）、
// File Meta Information（group 0002。PS3.10 7.1 で、いつも Explicit VR Little Endian）の転送構文と SOP Instance UID、
// データセットの先頭の SOP Instance UID (0008,0018)（File Meta と同じかを確かめる）・患者 ID (0010,0020)・StudyInstanceUID (0020,000D)。
// 監査の記録の「どの患者と検査に」を、Orthanc を呼ぶ前に残すため（3.5 の共通の決まり）と、結果不明を
// SOP Instance UID で照らすため。読めないファイルは Orthanc へ渡さずに断る。

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
const CHARSET = 0x00080005;
const SOP_UID = 0x00080018;
const PATIENT_ID = 0x00100020;
const STUDY_UID = 0x0020000d;
/** 入れ子の深さと、読む要素の数の上限（壊れたファイルで回り続けない） */
const MAX_DEPTH = 16;
const MAX_ELEMENTS = 100_000;
const UID = /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/;

export const isUid = (v: string) => v.length <= 64 && UID.test(v) && v.includes(".");

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

class Reader {
  private elements = 0;
  constructor(
    private readonly b: Uint8Array,
    private readonly view = new DataView(b.buffer, b.byteOffset, b.byteLength),
  ) {}
  need(pos: number, n: number) {
    if (pos < 0 || pos + n > this.b.byteLength) throw new DicomFileError("malformed", "DICOM のファイルの形が正しくありません");
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
  element(pos: number, implicit: boolean) {
    if (++this.elements > MAX_ELEMENTS) throw new DicomFileError("malformed", "DICOM のファイルの形が正しくありません");
    const tag = this.tag(pos);
    // 項目と区切り（FFFE,xxxx）は、どの転送構文でも VR を持たない（PS3.5 7.5）
    if (implicit || tag >>> 16 === 0xfffe) return { tag, vr: null, start: pos + 8, length: this.u32(pos + 4) };
    const vr = String.fromCharCode(...this.slice(pos + 4, 2));
    if (!/^[A-Z]{2}$/.test(vr)) throw new DicomFileError("malformed", "DICOM のファイルの形が正しくありません");
    return LONG_VR.has(vr)
      ? { tag, vr, start: pos + 12, length: this.u32(pos + 8) }
      : { tag, vr, start: pos + 8, length: this.u16(pos + 6) };
  }
  /** 長さが未定義の値（シーケンス・項目）を、区切りの後まで読み飛ばす。返すのは区切りの後の位置 */
  skipUndefined(pos: number, implicit: boolean, end: number, depth: number): number {
    if (depth > MAX_DEPTH) throw new DicomFileError("malformed", "DICOM のファイルの形が正しくありません");
    for (;;) {
      const e = this.element(pos, implicit);
      if (e.tag === end) return e.start;
      pos = this.next(e, implicit, depth);
    }
  }
  /** 要素の次の位置 */
  next(e: { tag: number; vr: string | null; start: number; length: number }, implicit: boolean, depth: number): number {
    if (e.length !== UNDEFINED) {
      this.need(e.start, e.length);
      return e.start + e.length;
    }
    if (e.tag === ITEM) return this.skipUndefined(e.start, implicit, ITEM_END, depth + 1);
    return this.skipUndefined(e.start, implicit, SEQUENCE_END, depth + 1);
  }
}

/** DICOM のファイルの頭を読む。DICOM でない・転送構文を読めない・形が壊れているときは DicomFileError を投げる */
export function readDicomFileHeader(bytes: Uint8Array): DicomFileHeader {
  if (bytes.byteLength < 132 || String.fromCharCode(...bytes.subarray(128, 132)) !== "DICM") {
    throw new DicomFileError("not_dicom", "DICOM のファイルではありません");
  }
  const r = new Reader(bytes);
  let pos = 132;
  let transferSyntaxUid = "";
  let sopInstanceUid = "";
  // File Meta Information（group 0002）は Explicit VR Little Endian
  while (pos + 4 <= bytes.byteLength && r.u16(pos) === 0x0002) {
    const e = r.element(pos, false);
    if (e.length === UNDEFINED) throw new DicomFileError("malformed", "DICOM のファイルの形が正しくありません");
    if (e.tag === 0x00020010) transferSyntaxUid = text(r.slice(e.start, e.length));
    if (e.tag === 0x00020003) sopInstanceUid = text(r.slice(e.start, e.length));
    pos = r.next(e, false, 0);
  }
  if (!isUid(transferSyntaxUid) || !isUid(sopInstanceUid)) {
    throw new DicomFileError("malformed", "DICOM のファイルの形が正しくありません");
  }
  if (UNSUPPORTED.has(transferSyntaxUid)) {
    throw new DicomFileError("unsupported_transfer_syntax", "この転送構文の DICOM のファイルは扱いません");
  }
  const implicit = transferSyntaxUid === IMPLICIT_LE;
  let patientId = "";
  let studyInstanceUid = "";
  let datasetSopInstanceUid = "";
  let charset = "";
  // データセットの先頭の要素を、StudyInstanceUID を読むまで（タグの順に並ぶ。PS3.5 7.1）
  while (pos + 8 <= bytes.byteLength) {
    const e = r.element(pos, implicit);
    if (e.tag > STUDY_UID) break;
    if (e.tag === SOP_UID && e.length !== UNDEFINED) datasetSopInstanceUid = text(r.slice(e.start, e.length));
    if (e.tag === CHARSET && e.length !== UNDEFINED) charset = text(r.slice(e.start, e.length));
    if (e.tag === PATIENT_ID && e.length !== UNDEFINED) patientId = patientIdText(r.slice(e.start, e.length), charset);
    if (e.tag === STUDY_UID && e.length !== UNDEFINED) studyInstanceUid = text(r.slice(e.start, e.length));
    pos = r.next(e, implicit, 0);
  }
  if (!isUid(studyInstanceUid)) throw new DicomFileError("malformed", "DICOM のファイルの形が正しくありません");
  // File Meta Information の Media Storage SOP Instance UID は、データセットの SOP Instance UID と同じ値（PS3.10 7.1）。
  // 違えば、どの画像かを決められないので断る（記録と照らし合わせに、取り違えた UID を使わない）
  if (datasetSopInstanceUid !== sopInstanceUid) {
    throw new DicomFileError("malformed", "DICOM のファイルの SOP Instance UID が一致しません");
  }
  return { transferSyntaxUid, sopInstanceUid, patientId, studyInstanceUid };
}
