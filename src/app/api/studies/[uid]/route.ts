import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { screenDeps } from "@/lib/screen-deps";
import { studyDetail } from "@/lib/study-list";

// 検査の詳細（画面の API。詳細のパネル）。検査・患者の情報とシリーズの並びを、役割の許可の一覧で絞って返す。
// 詳細を開いたことを監査の記録に残す（view_study。記録に失敗したら返さない）。

type Context = { params: Promise<{ uid: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    // 権限が無ければ、断ったことを記録して 403
    await requirePermission(session, "study.search", { action: "view_study", studyInstanceUid: uid });
    const detail = await studyDetail(await screenDeps(session), uid);
    if (!detail) return Response.json({ error: "検査が見つからない" }, { status: 404 });
    await audit(session, {
      action: "view_study",
      patientId: detail.summary.patientId,
      studyInstanceUid: uid,
      detail: { series: detail.series.length },
    });
    return Response.json({ study: detail.study, series: detail.series });
  } catch (error) {
    return errorResponse(error);
  }
}
