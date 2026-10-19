import { errorResponse } from "@/lib/api/respond";
import { requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { allowlistFor, modalityView } from "@/lib/fields";

// Orthanc に登録された機器の一覧（docs/spec.md の 3.3。段 4）。名前と AE タイトルは、機器を確かめる・送る役割に返す。
// 住所（Host・Port）と機器ごとの許可は、許可の一覧（modality）に載った役割にだけ返す（既定では管理者だけ。原則 8）。
// 断った要求は記録に残す（action は echo。機器の操作の記録と同じ所で追えるように）。

export async function GET() {
  try {
    const session = await requireSession();
    await requirePermission(session, "modality.check", { action: "echo", detail: { via: "list" } });
    const allowlist = allowlistFor(session.role);
    const modalities = (await getBackend().listModalities()).map((m) => modalityView(m, allowlist));
    return Response.json({ modalities });
  } catch (error) {
    return errorResponse(error);
  }
}
