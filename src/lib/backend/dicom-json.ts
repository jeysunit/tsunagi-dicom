import type { StudySummary } from "@/lib/backend/types";

// DICOM JSON（PS3.18 F.2）の読み取り。QIDO-RS の応答を StudySummary にする。

type DicomJsonValue = string | number | { Alphabetic?: string; Ideographic?: string; Phonetic?: string };
export type DicomJsonDataset = Record<string, { vr: string; Value?: DicomJsonValue[] } | undefined>;

export const TAG = {
  StudyDate: "00080020",
  StudyTime: "00080030",
  AccessionNumber: "00080050",
  ModalitiesInStudy: "00080061",
  StudyDescription: "00081030",
  PatientName: "00100010",
  PatientID: "00100020",
  PatientBirthDate: "00100030",
  PatientSex: "00100040",
  StudyInstanceUID: "0020000D",
  NumberOfStudyRelatedSeries: "00201206",
  NumberOfStudyRelatedInstances: "00201208",
} as const;

function values(ds: DicomJsonDataset, tag: string): DicomJsonValue[] {
  return ds[tag]?.Value ?? [];
}

export function stringValue(ds: DicomJsonDataset, tag: string): string {
  const v = values(ds, tag)[0];
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return personNameToString(v);
  return String(v);
}

/** PN の3つの組を、DICOM の文字列の形（Alphabetic=Ideographic=Phonetic）に戻す。末尾の空の組は落とす */
export function personNameToString(pn: { Alphabetic?: string; Ideographic?: string; Phonetic?: string }): string {
  const parts = [pn.Alphabetic ?? "", pn.Ideographic ?? "", pn.Phonetic ?? ""];
  while (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.join("=");
}

function numberValue(ds: DicomJsonDataset, tag: string): number | null {
  const v = values(ds, tag)[0];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

export function studyFromDicomJson(ds: DicomJsonDataset): StudySummary {
  return {
    studyInstanceUid: stringValue(ds, TAG.StudyInstanceUID),
    patientId: stringValue(ds, TAG.PatientID),
    patientName: stringValue(ds, TAG.PatientName),
    patientBirthDate: stringValue(ds, TAG.PatientBirthDate),
    patientSex: stringValue(ds, TAG.PatientSex),
    studyDate: stringValue(ds, TAG.StudyDate),
    studyTime: stringValue(ds, TAG.StudyTime),
    accessionNumber: stringValue(ds, TAG.AccessionNumber),
    studyDescription: stringValue(ds, TAG.StudyDescription),
    modalities: values(ds, TAG.ModalitiesInStudy).map(String),
    seriesCount: numberValue(ds, TAG.NumberOfStudyRelatedSeries),
    instanceCount: numberValue(ds, TAG.NumberOfStudyRelatedInstances),
  };
}

/** 新しい検査を上に（検査日・時刻の降順。同じなら StudyInstanceUID の順） */
export function sortStudiesNewestFirst(studies: StudySummary[]): StudySummary[] {
  return [...studies].sort(
    (a, b) =>
      (b.studyDate + b.studyTime).localeCompare(a.studyDate + a.studyTime) ||
      a.studyInstanceUid.localeCompare(b.studyInstanceUid),
  );
}
