import { errorResponse } from "@/lib/api/respond";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getConfig } from "@/lib/config";
import { receiveLogView } from "@/lib/receive-log";
import { ReceivePeriodError, resolveReceivePeriod } from "@/lib/receive-period";

// 受け取りの記録（docs/spec.md の 3.3。段 4）。期間（period・from・to）の中で Orthanc が受け取った検査を、新しい順に返す。
// 読む元は Orthanc の変更の記録（/changes）と、画像のメタデータ（RemoteAET など）。BFF には写して持たない。
// 返す項目は役割の許可の一覧（receive・study）で絞る。返した検査は、検索と同じ形で記録してから返す。

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    await requirePermission(session, "receive.view", { action: "receive_log" });
    const q = new URL(request.url).searchParams;
    let period;
    try {
      period = resolveReceivePeriod({ period: q.get("period"), from: q.get("from"), to: q.get("to") }, getConfig().timeZone);
    } catch (error) {
      if (error instanceof ReceivePeriodError) return Response.json({ error: error.message }, { status: 400 });
      throw error;
    }
    const { items, returned, overLimit, complete } = await receiveLogView(getBackend(), session.role, period);
    const patients = new Set(returned.map((r) => r.patientId));
    await audit(session, {
      action: "receive_log",
      patientId: patients.size === 1 ? [...patients][0]! : null,
      studyInstanceUid: returned.length === 1 ? returned[0]!.studyInstanceUid : null,
      detail: {
        period: { kind: period.kind, from: period.from, to: period.to },
        results: returned.length,
        overLimit,
        complete,
        returned: returned.map((s) => [s.patientId, s.studyInstanceUid]),
      },
    });
    // overLimit：期間の中に上限より多くあり、新しい上限の数だけを返した（画面は上限の知らせを出す）
    // complete=false：期間の始まりまで遡れなかった（画面は一部を読み込めなかったことを出す）
    return Response.json({ items, period: { kind: period.kind, from: period.from, to: period.to }, overLimit, complete });
  } catch (error) {
    return errorResponse(error);
  }
}
