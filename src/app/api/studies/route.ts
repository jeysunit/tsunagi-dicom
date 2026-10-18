import { errorResponse } from "@/lib/api/respond";
import { audit, getSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { searchAuditFields } from "@/lib/search-audit";

// 検査の件数と一覧（画面の API）。資格情報はサーバーの側だけで使う。
// 返す検査は記録してから返す（記録に失敗したら返さない）。
export async function GET() {
  try {
    const session = await getSession();
    const backend = getBackend();
    const [count, studies] = await Promise.all([backend.countStudies(), backend.searchStudies()]);
    await audit(session, searchAuditFields("api", studies));
    return Response.json({ count, studies });
  } catch (error) {
    return errorResponse(error);
  }
}
