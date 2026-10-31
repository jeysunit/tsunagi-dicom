import { describe, expect, it } from "vitest";
import { DicomFileError, readDicomFileHeader } from "@/lib/dicom-file";
import { dicomFile } from "./helpers/dicom-file";

// インポートの前に読む DICOM のファイルの頭（docs/spec.md の 3.5 の「取り込み」。PS3.10 7.1・PS3.5 7.1）
describe("DICOM のファイルの頭", () => {
  it.each([
    ["Explicit VR Little Endian", "1.2.840.10008.1.2.1"],
    ["Implicit VR Little Endian", "1.2.840.10008.1.2"],
    ["JPEG Baseline（データセットは Explicit VR Little Endian）", "1.2.840.10008.1.2.4.50"],
  ])("%s の患者 ID・StudyInstanceUID・SOP Instance UID を読む", (_, ts) => {
    expect(readDicomFileHeader(dicomFile({ transferSyntaxUid: ts, sequence: true }))).toEqual({
      transferSyntaxUid: ts,
      sopInstanceUid: "1.2.826.0.1.3680043.8.498.1",
      patientId: "IMP0001",
      studyInstanceUid: "1.2.826.0.1.3680043.8.498.2",
    });
  });
  it("128 バイトの前置きの後に DICM が無いものは DICOM でない", () => {
    expect(() => readDicomFileHeader(dicomFile({ noMagic: true }))).toThrow(expect.objectContaining({ reason: "not_dicom" }));
    expect(() => readDicomFileHeader(new TextEncoder().encode("PK\u0003\u0004 zip"))).toThrow(DicomFileError);
  });
  it.each(["1.2.840.10008.1.2.1.99", "1.2.840.10008.1.2.2"])("転送構文 %s は扱わない", (ts) => {
    expect(() => readDicomFileHeader(dicomFile({ transferSyntaxUid: ts }))).toThrow(
      expect.objectContaining({ reason: "unsupported_transfer_syntax" }),
    );
  });
  it("途中で切れたファイル・StudyInstanceUID の無いファイルは形の誤り", () => {
    const whole = dicomFile();
    expect(() => readDicomFileHeader(whole.subarray(0, 150))).toThrow(expect.objectContaining({ reason: "malformed" }));
    expect(() => readDicomFileHeader(dicomFile({ studyInstanceUid: "not-a-uid" }))).toThrow(expect.objectContaining({ reason: "malformed" }));
  });
  it.each([
    ["ISO_IR 192（UTF-8）", "ISO_IR 192", Buffer.from("患者0001", "utf8"), "患者0001"],
    ["ISO_IR 100（Latin-1）", "ISO_IR 100", Buffer.from("MÜLLER1", "latin1"), "MÜLLER1"],
    ["ISO 2022 の文字の集合", "\\ISO 2022 IR 87", Buffer.from([0x41, 0x1b, 0x24, 0x42, 0x34, 0x35]), "A\\x1b$B45"],
    ["UTF-8 として読めないバイト", "ISO_IR 192", Buffer.from([0x41, 0xff]), "A\\xff"],
  ])("ASCII でない患者 ID は文字の集合に合わせて読む：%s", (_, charset, bytes, expected) => {
    expect(readDicomFileHeader(dicomFile({ charset, patientIdBytes: bytes })).patientId).toBe(expected);
  });
  it("File Meta とデータセットの SOP Instance UID が違うファイルは形の誤り（PS3.10 7.1）", () => {
    expect(() => readDicomFileHeader(dicomFile({ datasetSopInstanceUid: "1.2.826.0.1.3680043.8.498.99" }))).toThrow(
      expect.objectContaining({ reason: "malformed" }),
    );
  });
});
