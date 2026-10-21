import { RequestError } from "@/lib/api/auth-route";
import { isDicomUid } from "@/lib/backend/relay-path";

/** URL の段の StudyInstanceUID を確かめる（数字と `.`、64 字まで）。だめなら 400 */
export function studyUidParam(value: unknown): string {
  return uidParam(value, "StudyInstanceUID");
}

/** URL の段の UID（SeriesInstanceUID・SOPInstanceUID など）を確かめる。だめなら 400。name は文言に出す DICOM の属性の名前 */
export function uidParam(value: unknown, name: "StudyInstanceUID" | "SeriesInstanceUID" | "SOPInstanceUID"): string {
  if (!isDicomUid(value)) throw new RequestError(400, `${name} が正しくありません`);
  return value;
}
