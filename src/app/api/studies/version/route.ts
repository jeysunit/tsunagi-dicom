import { errorResponse } from "@/lib/api/respond";
import { requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";

// 検査の一覧の版（画面の API。docs/spec.md の 3.1 の自動更新）。Orthanc の変更の記録の最後の番号だけを返す。
// 画面はこれを一定の間隔で読み、番号が変わったときだけ一覧（/api/studies）を読み直す。番号が変わらなければ、
// Orthanc へ検査の検索を求めず、検索の監査の記録（返した検査の組）も増やさない。
// 患者の情報を返さないので、読めたことは監査の記録に残さない（権限で断ったものは残す）。
// 画面の操作ではないので、画面のロックまでの時間は数え直さない（/api/auth/activity だけが数え直す）。
export async function GET() {
  try {
    await requirePermission(await requireSession(), "study.search", { action: "search", detail: { via: "version" } });
    return Response.json({ version: await getBackend().studyListVersion() });
  } catch (error) {
    return errorResponse(error);
  }
}
