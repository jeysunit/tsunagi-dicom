import { instanceTagRows } from "@/lib/all-values";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam, uidParam } from "@/lib/api/study-param";
import { stringValue, TAG } from "@/lib/backend/dicom-json";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getConfig } from "@/lib/config";

// 画像ごとの「主なタグ」（詳細のパネルのサムネイルから開く画像の場所。docs/spec.md の 3.1）。
// 選んだ1枚の画像の値（WADO-RS の metadata）のうち、設定（INSTANCE_TAGS）のタグだけを、設定の順に返す。設定に無いタグは返さない。
// 値の全部（…/values）と同じ明示の権限（dicom.all_values）のときだけ返し、断ったものも記録する。開いたことを監査の記録に残す。
// 画像サーバーへは BFF の側で求める（ブラウザに中継の道を足さない。docs/spec.md の 3.2）。読み取りだけ。

type Context = { params: Promise<{ uid: string; series: string; sop: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const p = await params;
    const uid = studyUidParam(p.uid);
    const series = uidParam(p.series, "SeriesInstanceUID");
    const sop = uidParam(p.sop, "SOPInstanceUID");
    const detail = { allValues: true, level: "instance", set: "configured", seriesInstanceUid: series, sopInstanceUid: sop };
    await requirePermission(session, "dicom.all_values", { action: "view_study", studyInstanceUid: uid, detail });
    const dataset = await getBackend().instanceDataset(uid, series, sop);
    if (!dataset) return Response.json({ error: "画像が見つかりません" }, { status: 404 });
    await audit(session, { action: "view_study", patientId: stringValue(dataset, TAG.PatientID), studyInstanceUid: uid, detail });
    return Response.json({ tags: instanceTagRows(dataset, getConfig().screen.instanceTags) });
  } catch (error) {
    return errorResponse(error);
  }
}
