import { errorResponse } from "@/lib/api/respond";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { screenDeps } from "@/lib/screen-deps";
import { searchAuditFields } from "@/lib/search-audit";
import { parseFilter } from "@/lib/study-filter";
import { listStudies } from "@/lib/study-list";

// 検査の一覧（画面の API）。すぐ絞れる見出しの値（?date=…&modality=…&status=…&q=…）で絞る（src/lib/study-filter.ts）。
// 返す項目は役割の許可の一覧（src/lib/fields.ts）に載ったものだけ（docs/spec.md 原則 8）。資格情報はサーバーの側だけで使う。
// 返す検査は記録してから返す（記録に失敗したら返さない）。
export async function GET(request: Request) {
  try {
    // 権限が無ければ、断ったことを記録して 403
    const session = await requirePermission(await requireSession(), "study.search", { action: "search", detail: { via: "api" } });
    const filter = parseFilter(new URL(request.url).searchParams);
    const { count, studies, returned } = await listStudies(await screenDeps(session), filter);
    await audit(session, searchAuditFields("api", returned));
    return Response.json({ count, studies });
  } catch (error) {
    return errorResponse(error);
  }
}
