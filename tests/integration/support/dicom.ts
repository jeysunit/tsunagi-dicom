import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ITEST } from "./env";

// 試験の画像（架空の患者だけ）。DCMTK の dump2dcm が読む文字の形（dump）で書き、コンテナの中で DICOM のファイルにする
// （docker/test/dcmtk/send-dumps.sh）。実の患者のデータは使わない。患者 ID は合成の印 JP-TEST- で始める。
// 画像は 8×8 の 8 bit のグレー（中身に意味は無い）。UID は 2.25.<UUID の 10 進>（試験のたびに新しい）。

export const newUid = () => `2.25.${BigInt(`0x${randomUUID().replaceAll("-", "")}`).toString(10)}`;

export interface SyntheticStudy {
  /** 組の名前（dump の置き場のフォルダ名） */
  batch: string;
  patientId: string;
  /** DICOM の PN（ローマ字=漢字=かな）。文字の集合は charset */
  patientName: string;
  /**
   * 文字の集合（SpecificCharacterSet）。既定は ISO_IR 192（UTF-8）。ほかの値のときは、氏名と検査名を encode で
   * 書く（既定は ISO-2022-JP。JIS X 0208 を ESC $ B で切り替える形）
   */
  charset: string;
  /** 氏名と検査名を、charset の符号の並び（1 文字が 1 バイトの文字列。latin1 で書く）にする。ISO_IR 192 では使わない */
  encode?: (text: string) => string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  accessionNumber: string;
  studyDescription: string;
  modality: "CT";
  sopInstanceUids: string[];
  /** 生年月日（DA）・性別（CS）・紹介医（PN）。詳細条件の試験で替える */
  patientBirthDate: string;
  patientSex: string;
  referringPhysicianName: string;
}

export function syntheticStudy(
  batch: string,
  index: number,
  instances: number,
  extra: Partial<
    Pick<SyntheticStudy, "patientBirthDate" | "patientSex" | "referringPhysicianName" | "studyDescription" | "accessionNumber" | "patientName" | "charset" | "encode">
  > = {},
): SyntheticStudy {
  return {
    batch,
    patientId: `JP-TEST-IT${String(index).padStart(2, "0")}`,
    patientName: `ITEST^TARO${index}=試験^太郎=しけん^たろう`,
    studyInstanceUid: newUid(),
    seriesInstanceUid: newUid(),
    accessionNumber: `IT-ACC-${String(index).padStart(4, "0")}`,
    studyDescription: `ITEST study ${index}`,
    modality: "CT",
    sopInstanceUids: Array.from({ length: instances }, () => newUid()),
    patientBirthDate: "19800101",
    patientSex: "M",
    referringPhysicianName: "ITEST^REFERRER",
    charset: "ISO_IR 192",
    ...extra,
  };
}

/** JIS X 0208 の 1 文字から、ISO-2022-JP の 2 バイト（0x21〜0x7E の組）への表。Node の ISO-2022-JP の読み取りから逆に作る */
let jisTable: Map<string, string> | undefined;
function jisOf(char: string): string | undefined {
  if (!jisTable) {
    jisTable = new Map();
    const decoder = new TextDecoder("iso-2022-jp");
    for (let hi = 0x21; hi <= 0x7e; hi++) {
      for (let lo = 0x21; lo <= 0x7e; lo++) {
        const text = decoder.decode(Uint8Array.from([0x1b, 0x24, 0x42, hi, lo, 0x1b, 0x28, 0x42]));
        if (text.length === 1 && text !== "�" && !jisTable.has(text)) jisTable.set(text, String.fromCharCode(hi, lo));
      }
    }
  }
  return jisTable.get(char);
}

/**
 * 文字を ISO-2022-JP（ISO 2022 IR 87）の 7 bit の文字の並びにする。ASCII に戻してから区切り（`^`・`=`・`\`）を書く。
 * dump の `[…]` の中に入るので、JIS の 2 バイトに `[`・`\`・`]` が出る文字は断る
 */
export function encodeIso2022Jp(text: string, backToG0 = "\x1b(B"): string {
  let out = "";
  let kanji = false;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) {
      if (kanji) out += backToG0;
      kanji = false;
      out += ch;
      continue;
    }
    const jis = jisOf(ch);
    if (!jis) throw new Error(`ISO 2022 IR 87 で書けない文字：${ch}`);
    if (/[[\\\]]/.test(jis)) throw new Error(`dump に書けない JIS の符号（${ch}）`);
    if (!kanji) out += "\x1b$B";
    kanji = true;
    out += jis;
  }
  return kanji ? `${out}${backToG0}` : out;
}

/**
 * 先頭の値が ISO 2022 IR 13 の画像の氏名・検査名。PS3.5 の H.3.2 の例と同じく、区切りの前で G0 を
 * ISO-IR 14（JIS X 0201 のローマ字。ESC ( J）に戻す
 */
export const encodeIso2022JpAfterIr13 = (text: string): string => encodeIso2022Jp(text, "\x1b(J");

/**
 * ISO 2022 IR 13（JIS X 0201）の 1 バイトの並びにする。半角カナ（U+FF61〜U+FF9F）は 0xA1〜0xDF、ASCII はそのまま
 */
export function encodeIr13(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 0x80) out += ch;
    else if (code >= 0xff61 && code <= 0xff9f) out += String.fromCharCode(code - 0xff61 + 0xa1);
    else throw new Error(`ISO 2022 IR 13 で書けない文字：${ch}`);
  }
  return out;
}

/** KS X 1001 の 1 文字から、EUC-KR の 2 バイトへの表。Node の EUC-KR の読み取りから逆に作る */
let ksTable: Map<string, string> | undefined;
function ksOf(char: string): string | undefined {
  if (!ksTable) {
    ksTable = new Map();
    const decoder = new TextDecoder("euc-kr");
    for (let hi = 0xb0; hi <= 0xc8; hi++) {
      for (let lo = 0xa1; lo <= 0xfe; lo++) {
        const text = decoder.decode(Uint8Array.from([hi, lo]));
        if (text.length === 1 && text !== "�" && !ksTable.has(text)) ksTable.set(text, String.fromCharCode(hi, lo));
      }
    }
  }
  return ksTable.get(char);
}

/**
 * ISO 2022 IR 149（KS X 1001）の並びにする。ハングルの前に G1 への指示（ESC $ ) C）を置き、2 バイト（0xB0〜0xC8、
 * 0xA1〜0xFE）を 8 bit のまま書く。ASCII はそのまま
 */
export function encodeIso2022Kr(text: string): string {
  let out = "";
  let designated = false;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) {
      out += ch;
      continue;
    }
    const ks = ksOf(ch);
    if (!ks) throw new Error(`ISO 2022 IR 149 で書けない文字：${ch}`);
    if (!designated) out += "\x1b$)C";
    designated = true;
    out += ks;
  }
  return out;
}

const PIXELS = Array.from({ length: 64 }, (_, i) => (i * 4).toString(16).padStart(2, "0")).join("\\");

function dump(study: SyntheticStudy, sopInstanceUid: string, instanceNumber: number): string {
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  // ISO_IR 192 以外の検査は、文字の値を charset の符号の並びで書く（既定は ISO-2022-JP の 7 bit。ASCII だけになる）
  const text = study.charset === "ISO_IR 192" ? (s: string) => s : (study.encode ?? encodeIso2022Jp);
  return [
    `(0008,0005) CS [${study.charset}]`,
    // CT Image Storage
    "(0008,0016) UI [1.2.840.10008.5.1.4.1.1.2]",
    `(0008,0018) UI [${sopInstanceUid}]`,
    `(0008,0020) DA [${today}]`,
    "(0008,0030) TM [090000]",
    `(0008,0050) SH [${study.accessionNumber}]`,
    `(0008,0060) CS [${study.modality}]`,
    `(0008,0090) PN [${study.referringPhysicianName}]`,
    `(0008,1030) LO [${text(study.studyDescription)}]`,
    `(0010,0010) PN [${text(study.patientName)}]`,
    `(0010,0020) LO [${study.patientId}]`,
    `(0010,0030) DA [${study.patientBirthDate}]`,
    `(0010,0040) CS [${study.patientSex}]`,
    `(0020,000d) UI [${study.studyInstanceUid}]`,
    `(0020,000e) UI [${study.seriesInstanceUid}]`,
    "(0020,0010) SH [IT1]",
    "(0020,0011) IS [1]",
    `(0020,0013) IS [${instanceNumber}]`,
    "(0028,0002) US 1",
    "(0028,0004) CS [MONOCHROME2]",
    "(0028,0010) US 8",
    "(0028,0011) US 8",
    "(0028,0100) US 8",
    "(0028,0101) US 8",
    "(0028,0102) US 7",
    "(0028,0103) US 0",
    `(7fe0,0010) OB ${PIXELS}`,
    "",
  ].join("\n");
}

/** 検査の dump を .e2e/itest/dumps/<組>/ に書く（前の同じ組は消す） */
export function writeDumps(study: SyntheticStudy): void {
  const dir = path.join(ITEST.workDir, "dumps", study.batch);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  study.sopInstanceUids.forEach((uid, i) => {
    writeFileSync(path.join(dir, `img${String(i + 1).padStart(4, "0")}.dump`), dump(study, uid, i + 1), study.charset === "ISO_IR 192" ? "utf8" : "latin1");
  });
}
