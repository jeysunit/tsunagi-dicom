import { datasetRows } from "@/lib/all-values";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { stringValue, TAG } from "@/lib/backend/dicom-json";
import { audit, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";

// すべての DICOM の値（検査の単位）。許可の一覧とは別の明示の権限（dicom.all_values。既定では管理者・技師）の
// ときだけ返す（docs/spec.md 原則 8）。権限の無い役割は 403。開いたことを監査の記録に残す。

type Context = { params: Promise<{ uid: string }> };

export async function GET(_request: Request, { params }: Context) {
  try {
    const session = await requireSession("dicom.all_values");
    const uid = studyUidParam((await params).uid);
    const dataset = await getBackend().studyDataset(uid);
    if (!dataset) return Response.json({ error: "検査が見つからない" }, { status: 404 });
    await audit(session, {
      action: "view_study",
      patientId: stringValue(dataset, TAG.PatientID),
      studyInstanceUid: uid,
      detail: { allValues: true },
    });
    return Response.json({ values: datasetRows(dataset) });
  } catch (error) {
    return errorResponse(error);
  }
}
