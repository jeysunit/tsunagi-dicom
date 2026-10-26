import { errorResponse } from "@/lib/api/respond";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { SENT_LIMIT, sentLogView, sentRange } from "@/lib/sent-log";

// 送信一覧の画面の API（docs/spec.md の 3.4）。読むだけ。期間（?period=today|yesterday|week|range、range は from・to〔yyyy-MM-dd〕）の
// 中の送信を新しい順に、上限 1,000 件まで返す。返す項目は役割の許可の一覧（sent・study）で絞る。
// 開いたことは、返した送信の患者 ID と StudyInstanceUID の組とともに記録してから返す（受信一覧と同じ形。記録できなければ返さない）。

export async function GET(request: Request) {
  try {
    const session = await requireSession();
    await requirePermission(session, "send.view", { action: "send_log" });
    const range = sentRange(new URL(request.url).searchParams, getConfig().timeZone);
    const { items, returned, truncated } = await sentLogView(
      { db: await getDb(), backend: getBackend(), session, role: session.role },
      range,
    );
    const patients = new Set(returned.map((r) => r.patientId));
    await audit(session, {
      action: "send_log",
      patientId: patients.size === 1 ? [...patients][0]! : null,
      studyInstanceUid: returned.length === 1 ? returned[0]!.studyInstanceUid : null,
      detail: {
        period: range.period,
        from: range.fromDate,
        to: range.toDate,
        results: returned.length,
        truncated,
        returned: returned.map((r) => [r.patientId, r.studyInstanceUid]),
      },
    });
    return Response.json({ items, truncated, limit: SENT_LIMIT, from: range.fromDate, to: range.toDate });
  } catch (error) {
    return errorResponse(error);
  }
}
