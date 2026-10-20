import { errorResponse } from "@/lib/api/respond";
import { studyUidParam, uidParam } from "@/lib/api/study-param";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";

// シリーズの中の画像の並び（画面の API。詳細のパネルの「DICOM タグ」の画像単位。docs/spec.md の 3.1）。
// 画像単位の DICOM タグを選ぶためのもので、すべての DICOM の値と同じ権限（dicom.all_values）のときだけ返す。
// 返すのは、画像を選ぶのに要る値（SOPInstanceUID・SOPClassUID・画像の番号・フレームの数）だけ。
// 画像サーバーへは BFF の側で QIDO-RS を求める（中継は QIDO-RS を通さない。docs/spec.md の 3.2）。開いたことを監査の記録に残す。

type Context = { params: Promise<{ uid: string; series: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const p = await params;
    const uid = studyUidParam(p.uid);
    const series = uidParam(p.series, "SeriesInstanceUID");
    const detail = { allValues: true, level: "instances", seriesInstanceUid: series };
    await requirePermission(session, "dicom.all_values", { action: "view_study", studyInstanceUid: uid, detail });
    const instances = await getBackend().searchInstances(uid, series);
    await audit(session, { action: "view_study", studyInstanceUid: uid, detail: { ...detail, count: instances.length } });
    return Response.json({
      instances: instances.map(({ sopInstanceUid, sopClassUid, instanceNumber, numberOfFrames }) => ({
        sopInstanceUid,
        sopClassUid,
        instanceNumber,
        numberOfFrames,
      })),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
