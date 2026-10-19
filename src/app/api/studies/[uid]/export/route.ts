import { RequestError } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { sameOriginRequest } from "@/lib/api/same-origin";
import { studyUidParam } from "@/lib/api/study-param";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import { assertWriteAllowed } from "@/lib/pacs-ops";

// 書き出し（ZIP。docs/spec.md の 3.5。段 5）。検査の画像の全部を、Orthanc の /studies/{id}/archive から受けて、そのまま流す。
// ZIP は患者の情報を含んだまま施設の外へ持ち出せる形になるので：
// - 役割（study.export）を確かめ、検証モードでは DEV_ALLOW_WRITE=true のときだけ通す。
// - このアプリの画面（同じ origin）からの要求だけを受ける（ほかのサイトから落とさせない）。
// - 落とす前に記録し（記録できなければ渡さない）、Orthanc が断れば失敗を記録する。
// - ファイルの名前に患者の情報を入れない。BFF には残さない（流すだけ）。

type Context = { params: Promise<{ uid: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    if (!sameOriginRequest(request)) {
      await audit(session, {
        action: "export",
        outcome: "denied",
        studyInstanceUid: uid,
        detail: { reason: "not-same-origin", site: request.headers.get("sec-fetch-site")?.slice(0, 32) ?? null },
      });
      throw new RequestError(403, "このアプリの画面から開いた要求だけを受ける");
    }
    await requirePermission(session, "study.export", { action: "export", studyInstanceUid: uid });
    await assertWriteAllowed(session, { action: "export", studyInstanceUid: uid });

    // 落とす検査は、URL の UID から Orthanc で引いたちょうど1件（2件以上は lookupStudy が 409）。その UID が求めたものと合うことも確かめる
    const backend = getBackend();
    const orthancId = await backend.lookupStudy(uid);
    const info = orthancId ? await backend.studyInfo(orthancId) : null;
    if (!orthancId || !info) return Response.json({ error: "検査が見つからない" }, { status: 404 });
    if (info.studyInstanceUid !== uid) {
      await audit(session, { action: "export", outcome: "denied", patientId: info.patientId, studyInstanceUid: uid, detail: { reason: "mismatch" } });
      return Response.json({ error: "Orthanc で引いた検査の StudyInstanceUID が、求めた UID と合わない" }, { status: 409 });
    }
    const patientId = info.patientId;

    // 落とす前に記録する（記録できなければ渡さない）
    await audit(session, { action: "export", outcome: "success", patientId, studyInstanceUid: uid, detail: { format: "zip" } });
    let zip: Response;
    try {
      zip = await backend.exportStudy(orthancId);
    } catch (error) {
      await audit(session, {
        action: "export",
        outcome: "failed",
        patientId,
        studyInstanceUid: uid,
        detail: { format: "zip", status: error instanceof BackendError ? error.status : 502 },
      });
      throw error;
    }
    return new Response(zip.body, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        // 名前は Orthanc の中の ID の頭だけ（患者 ID・氏名・UID を入れない）
        "content-disposition": `attachment; filename="study-${orthancId.slice(0, 8)}.zip"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
