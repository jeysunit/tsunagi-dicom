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
  /** DICOM の PN（ローマ字=漢字=かな）。文字の集合は ISO_IR 192（UTF-8） */
  patientName: string;
  studyInstanceUid: string;
  seriesInstanceUid: string;
  accessionNumber: string;
  studyDescription: string;
  modality: "CT";
  sopInstanceUids: string[];
}

export function syntheticStudy(batch: string, index: number, instances: number): SyntheticStudy {
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
  };
}

const PIXELS = Array.from({ length: 64 }, (_, i) => (i * 4).toString(16).padStart(2, "0")).join("\\");

function dump(study: SyntheticStudy, sopInstanceUid: string, instanceNumber: number): string {
  const today = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return [
    "(0008,0005) CS [ISO_IR 192]",
    // CT Image Storage
    "(0008,0016) UI [1.2.840.10008.5.1.4.1.1.2]",
    `(0008,0018) UI [${sopInstanceUid}]`,
    `(0008,0020) DA [${today}]`,
    "(0008,0030) TM [090000]",
    `(0008,0050) SH [${study.accessionNumber}]`,
    `(0008,0060) CS [${study.modality}]`,
    "(0008,0090) PN [ITEST^REFERRER]",
    `(0008,1030) LO [${study.studyDescription}]`,
    `(0010,0010) PN [${study.patientName}]`,
    `(0010,0020) LO [${study.patientId}]`,
    "(0010,0030) DA [19800101]",
    "(0010,0040) CS [M]",
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
    writeFileSync(path.join(dir, `img${String(i + 1).padStart(4, "0")}.dump`), dump(study, uid, i + 1), "utf8");
  });
}
