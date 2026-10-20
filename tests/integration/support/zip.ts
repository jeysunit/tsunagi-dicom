import { inflateRawSync } from "node:zlib";

// 書き出しの ZIP を開く（試験だけ）。中央のディレクトリを読み、各ファイルの名前と中身を取り出す。
// 形が崩れていれば投げる（「ZIP が開ける」ことの確かめ）。ZIP64 の終わりの記録にも対応する。

export interface ZipEntry {
  name: string;
  data: Buffer;
}

const EOCD = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) return i;
  }
  throw new Error("ZIP の終わりの記録が無い");
}

/** ZIP64 の拡張の項目（0x0001）から、64 bit の値を順に読む */
function zip64Values(extra: Buffer): bigint[] {
  for (let p = 0; p + 4 <= extra.length; ) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      const values: bigint[] = [];
      for (let q = p + 4; q + 8 <= p + 4 + size; q += 8) values.push(extra.readBigUInt64LE(q));
      return values;
    }
    p += 4 + size;
  }
  return [];
}

export function readZip(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== ZIP64_EOCD_LOCATOR) throw new Error("ZIP64 の終わりの記録の場所が無い");
    const z = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(z) !== ZIP64_EOCD) throw new Error("ZIP64 の終わりの記録が無い");
    count = Number(buf.readBigUInt64LE(z + 32));
    offset = Number(buf.readBigUInt64LE(z + 48));
  }

  const entries: ZipEntry[] = [];
  let p = offset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL) throw new Error(`中央のディレクトリの ${i + 1} 件目の印が違う`);
    const method = buf.readUInt16LE(p + 10);
    let compressed = buf.readUInt32LE(p + 20);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString("utf8");
    const extra = buf.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
    // ZIP64：0xffffffff の項目だけが、拡張の項目に順に入る（元の大きさ・圧縮した大きさ・場所）
    const wide = zip64Values(extra);
    let w = 0;
    if (buf.readUInt32LE(p + 24) === 0xffffffff) w++;
    if (compressed === 0xffffffff) compressed = Number(wide[w++] ?? 0n);
    if (localOffset === 0xffffffff) localOffset = Number(wide[w++] ?? 0n);

    if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error(`${name} の頭の印が違う`);
    const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(start, start + compressed);
    let data: Buffer;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`${name} の圧縮の方式（${method}）を読めない`);
    if (!name.endsWith("/")) entries.push({ name, data });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** DICOM の Part 10 のファイル（128 バイトの前置きの後に DICM） */
export const isDicomFile = (data: Buffer) => data.length > 132 && data.subarray(128, 132).toString("latin1") === "DICM";
