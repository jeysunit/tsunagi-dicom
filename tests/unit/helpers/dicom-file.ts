// 試験のための、合成の DICOM のファイル（PS3.10 の形：128 バイトの前置き・"DICM"・File Meta Information・データセット）。
// 画素は入れない。値は合成のもので、実の患者のデータではない。

/** 値のバイト（文字列は latin1 で）を、偶数の長さにそろえる */
const pad = (value: string | Buffer, padding: string) => {
  const b = typeof value === "string" ? Buffer.from(value, "latin1") : value;
  return b.length % 2 ? Buffer.concat([b, Buffer.from(padding, "latin1")]) : b;
};

function tagBytes(tag: number) {
  const b = Buffer.alloc(4);
  b.writeUInt16LE(tag >>> 16, 0);
  b.writeUInt16LE(tag & 0xffff, 2);
  return b;
}

/** Explicit VR Little Endian の要素（長さが 2 バイトの VR だけ） */
function explicit(tag: number, vr: string, value: string | Buffer) {
  const v = pad(value, vr === "UI" ? "\0" : " ");
  const len = Buffer.alloc(2);
  len.writeUInt16LE(v.length, 0);
  return Buffer.concat([tagBytes(tag), Buffer.from(vr, "latin1"), len, v]);
}

/** Implicit VR Little Endian の要素 */
function implicitElement(tag: number, value: string | Buffer, padding = " ") {
  const v = pad(value, padding);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(v.length, 0);
  return Buffer.concat([tagBytes(tag), len, v]);
}

/** 長さが未定義の空でない SQ（ReferencedStudySequence (0008,1110)）。中の項目も長さが未定義 */
function undefinedSequence(implicit: boolean) {
  const inner = implicit ? implicitElement(0x00081150, "1.2.3", "\0") : explicit(0x00081150, "UI", "1.2.3");
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return b;
  };
  const head = implicit
    ? Buffer.concat([tagBytes(0x00081110), u32(0xffffffff)])
    : Buffer.concat([tagBytes(0x00081110), Buffer.from("SQ\0\0", "latin1"), u32(0xffffffff)]);
  return Buffer.concat([
    head,
    tagBytes(0xfffee000),
    u32(0xffffffff),
    inner,
    tagBytes(0xfffee00d),
    u32(0),
    tagBytes(0xfffee0dd),
    u32(0),
  ]);
}

export interface DicomFileOptions {
  transferSyntaxUid?: string;
  sopInstanceUid?: string;
  patientId?: string;
  studyInstanceUid?: string;
  /** PatientID の前に、長さが未定義の SQ を入れる */
  sequence?: boolean;
  /** "DICM" を入れない */
  noMagic?: boolean;
  /** データセットの SOP Instance UID を File Meta と違う値にする */
  datasetSopInstanceUid?: string;
  /** Specific Character Set (0008,0005)。あれば入れ、患者 ID のバイトは patientIdBytes で渡す */
  charset?: string;
  patientIdBytes?: Buffer;
  /** データセットの後ろに足す要素（タグの並びを崩したファイルを作る） */
  append?: { tag: number; vr: string; value: string }[];
  /** File Meta の後ろ（データセットの前）に足す group 0002 の要素（Group Length の範囲の外に置く） */
  outsideMeta?: { tag: number; vr: string; value: string }[];
  /** File Meta Information Group Length の値に足す数（範囲を崩す）。null なら Group Length を入れない */
  groupLengthDelta?: number | null;
  /** ファイルの最後に足すバイト */
  trailing?: Buffer;
}

export function dicomFile(o: DicomFileOptions = {}): Uint8Array {
  const ts = o.transferSyntaxUid ?? "1.2.840.10008.1.2.1";
  const sop = o.sopInstanceUid ?? "1.2.826.0.1.3680043.8.498.1";
  const implicit = ts === "1.2.840.10008.1.2";
  const metaBody = Buffer.concat([
    explicit(0x00020002, "UI", "1.2.840.10008.5.1.4.1.1.7"),
    explicit(0x00020003, "UI", sop),
    explicit(0x00020010, "UI", ts),
  ]);
  const groupLength = Buffer.concat([tagBytes(0x00020000), Buffer.from("UL", "latin1"), Buffer.from([4, 0]), Buffer.alloc(4)]);
  groupLength.writeUInt32LE(metaBody.length + (o.groupLengthDelta ?? 0), 8);
  const el = (tag: number, vr: string, value: string | Buffer) =>
    implicit ? implicitElement(tag, value, vr === "UI" ? "\0" : " ") : explicit(tag, vr, value);
  const outsideMeta = (o.outsideMeta ?? []).map((e) => explicit(e.tag, e.vr, e.value));
  const dataset = Buffer.concat([
    ...(o.charset ? [el(0x00080005, "CS", o.charset)] : []),
    el(0x00080018, "UI", o.datasetSopInstanceUid ?? sop),
    ...(o.sequence ? [undefinedSequence(implicit)] : []),
    el(0x00100010, "PN", "TEST^IMPORT"),
    el(0x00100020, "LO", o.patientIdBytes ?? o.patientId ?? "IMP0001"),
    el(0x0020000d, "UI", o.studyInstanceUid ?? "1.2.826.0.1.3680043.8.498.2"),
    el(0x0020000e, "UI", "1.2.826.0.1.3680043.8.498.3"),
    ...(o.append ?? []).map((e) => el(e.tag, e.vr, e.value)),
  ]);
  return new Uint8Array(
    Buffer.concat([
      Buffer.alloc(128),
      Buffer.from(o.noMagic ? "XXXX" : "DICM", "latin1"),
      ...(o.groupLengthDelta === null ? [] : [groupLength]),
      metaBody,
      ...outsideMeta,
      dataset,
      o.trailing ?? Buffer.alloc(0),
    ]),
  );
}
