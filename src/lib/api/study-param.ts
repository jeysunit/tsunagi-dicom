import { RequestError } from "@/lib/api/auth-route";
import { isDicomUid } from "@/lib/backend/relay-path";

/** URL の段の StudyInstanceUID を確かめる（数字と `.`、64 字まで）。だめなら 400 */
export function studyUidParam(value: unknown): string {
  if (!isDicomUid(value)) throw new RequestError(400, "StudyInstanceUID の形が誤り");
  return value;
}
