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
  // タグの重複・順の乱れ（PS3.5 7.1）：tsunagi が読む値と、Orthanc（DCMTK）が保存する値が食い違いうるので断る
  it.each([
    ["StudyInstanceUID が二度ある", [{ tag: 0x0020000d, vr: "UI", value: "1.2.826.0.1.3680043.8.498.66" }]],
    ["患者 ID が StudyInstanceUID の後ろにもう一度ある", [{ tag: 0x00100020, vr: "LO", value: "OTHER01" }]],
    ["SOP Instance UID が後ろにもう一度ある", [{ tag: 0x00080018, vr: "UI", value: "1.2.826.0.1.3680043.8.498.1" }]],
    ["後ろの要素の順が乱れている", [{ tag: 0x00280010, vr: "US", value: "\u0001\u0000" }, { tag: 0x00200013, vr: "IS", value: "1" }]],
  ])("データセットの要素の並びが崩れたファイルは形の誤り：%s", (_, append) => {
    expect(() => readDicomFileHeader(dicomFile({ append }))).toThrow(expect.objectContaining({ reason: "malformed" }));
    expect(() => readDicomFileHeader(dicomFile({ append, transferSyntaxUid: "1.2.840.10008.1.2" }))).toThrow(
      expect.objectContaining({ reason: "malformed" }),
    );
  });
  it("昇順に並んだ後ろの要素は読み飛ばし、値は変わらない", () => {
    const append = [{ tag: 0x00200013, vr: "IS", value: "1" }, { tag: 0x00280010, vr: "US", value: "\u0001\u0000" }];
    expect(readDicomFileHeader(dicomFile({ append }))).toMatchObject({ patientId: "IMP0001", studyInstanceUid: "1.2.826.0.1.3680043.8.498.2" });
  });
  it.each([
    ["Group Length (0002,0000) が無い", { groupLengthDelta: null }],
    ["Group Length が短く、範囲の外に File Meta の要素がはみ出す", { groupLengthDelta: -4 }],
    ["Group Length が長く、データセットの頭を File Meta として読む", { groupLengthDelta: 8 }],
    ["Group Length の範囲の外（データセットの前）に group 0002 の要素がある", { outsideMeta: [{ tag: 0x00020016, vr: "AE", value: "OTHER" }] }],
    ["データセットの後ろに半端なバイトがある", { trailing: Buffer.from([1, 2, 3, 4]) }],
  ])("File Meta Information Group Length を守らないファイルは形の誤り：%s", (_, options) => {
    expect(() => readDicomFileHeader(dicomFile(options))).toThrow(expect.objectContaining({ reason: "malformed" }));
  });
  it("Explicit VR で、読む値の要素の VR が違うファイルは形の誤り（PS3.6 の 6 章）", () => {
    // 患者 ID (0010,0020) の VR だけを LO から SH に替える
    const file = Buffer.from(dicomFile());
    const at = file.indexOf(Buffer.from([0x10, 0x00, 0x20, 0x00, 0x4c, 0x4f]));
    expect(at).toBeGreaterThan(132);
    file.write("SH", at + 4, "latin1");
    expect(() => readDicomFileHeader(new Uint8Array(file))).toThrow(expect.objectContaining({ reason: "malformed" }));
  });
  it("File Meta とデータセットの SOP Instance UID が違うファイルは形の誤り（PS3.10 7.1）", () => {
    expect(() => readDicomFileHeader(dicomFile({ datasetSopInstanceUid: "1.2.826.0.1.3680043.8.498.99" }))).toThrow(
      expect.objectContaining({ reason: "malformed" }),
    );
  });
});
