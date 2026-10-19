import { errorResponse } from "@/lib/api/respond";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { receiveLogView } from "@/lib/receive-log";

// 受け取りの記録（docs/spec.md の 3.3。段 4）。Orthanc が受け取った検査を、新しい順に返す。
// 読む元は Orthanc の変更の記録（/changes）と、画像のメタデータ（RemoteAET など）。BFF には写して持たない。
// 返す項目は役割の許可の一覧（receive・study）で絞る。返した検査は、検索と同じ形で記録してから返す。

export async function GET() {
  try {
    const session = await requireSession();
    await requirePermission(session, "receive.view", { action: "receive_log" });
    const { items, returned, complete } = await receiveLogView(getBackend(), session.role);
    const patients = new Set(returned.map((r) => r.patientId));
    await audit(session, {
      action: "receive_log",
      patientId: patients.size === 1 ? [...patients][0]! : null,
      studyInstanceUid: returned.length === 1 ? returned[0]!.studyInstanceUid : null,
      detail: { results: returned.length, complete, returned: returned.map((s) => [s.patientId, s.studyInstanceUid]) },
    });
    // complete=false：読む範囲の上限で止まり、もっと古い受け取りを読めていない（画面は「ここまでしか読めていない」と出す）
    return Response.json({ items, complete });
  } catch (error) {
    return errorResponse(error);
  }
}
