import { errorResponse } from "@/lib/api/respond";
import { audit, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { searchAuditFields } from "@/lib/search-audit";
import { listStudies } from "@/lib/study-list";

// 検査の件数と一覧（画面の API）。資格情報はサーバーの側だけで使う。
// 返す項目は役割の許可の一覧（src/lib/fields.ts）に載ったものだけ（docs/spec.md 原則 8）。
// 返す検査は記録してから返す（記録に失敗したら返さない）。
export async function GET() {
  try {
    const session = await requireSession("study.search");
    const { count, studies, returned } = await listStudies(getBackend(), session.role);
    await audit(session, searchAuditFields("api", returned));
    return Response.json({ count, studies });
  } catch (error) {
    return errorResponse(error);
  }
}
