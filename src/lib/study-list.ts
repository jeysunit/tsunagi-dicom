import type { Role } from "@/lib/auth/roles";
import type { Backend, StudyCount, StudySummary } from "@/lib/backend/types";
import { allowlistFor, studyView, type FieldAllowlistMap, type StudyView } from "@/lib/fields";

// 検査の一覧（画面の API と、一覧の頁の最初の描画で同じものを使う）。
// 画像サーバーの応答を、役割の許可の一覧（src/lib/fields.ts）で絞った形にしてから返す。

export interface StudyListResult {
  count: StudyCount;
  /** ブラウザへ返す形（許可の一覧で絞ったもの） */
  studies: StudyView[];
  /** 監査の記録に残す、返した検査（ブラウザへは返さない） */
  returned: StudySummary[];
}

export async function listStudies(
  backend: Pick<Backend, "countStudies" | "searchStudies">,
  role: Role,
  allowlists?: FieldAllowlistMap,
): Promise<StudyListResult> {
  const [count, studies] = await Promise.all([backend.countStudies(), backend.searchStudies()]);
  const allowlist = allowlistFor(role, allowlists);
  return { count, studies: studies.map((s) => studyView(s, allowlist)), returned: studies };
}
