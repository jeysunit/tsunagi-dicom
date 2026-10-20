import { errorResponse } from "@/lib/api/respond";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { screenDeps } from "@/lib/screen-deps";
import { searchAuditFields } from "@/lib/search-audit";
import { filterToSearchParams, parseFilter } from "@/lib/study-filter";
import { resolveSearchTrigger } from "@/lib/search-trigger";
import { listStudies } from "@/lib/study-list";

// 検査の一覧（画面の API）。すぐ絞れる見出しの値（?date=…&modality=…&status=…&q=…）で絞る（src/lib/study-filter.ts）。
// 返す項目は役割の許可の一覧（src/lib/fields.ts）に載ったものだけ（docs/spec.md 原則 8）。資格情報はサーバーの側だけで使う。
// 返す検査は記録してから返す（記録に失敗したら返さない）。
// `?refresh=auto` は、画面の自動更新の読み直しの名乗り（docs/spec.md の 3.1・3.6）。絞り込みには使わない。
// 名乗りはブラウザが付ける値なので、権限の確かめ・監査の行（返した検査の組まで全部）は、名乗りで変えない。
// 直前の手動の検索と同じ条件のときだけ、監査の detail に申告された値として trigger: "auto" を残す（src/lib/search-trigger.ts）。
export async function GET(request: Request) {
  try {
    // 権限が無ければ、断ったことを記録して 403
    const session = await requirePermission(await requireSession(), "study.search", { action: "search", detail: { via: "api" } });
    const params = new URL(request.url).searchParams;
    const filter = parseFilter(params);
    const trigger = resolveSearchTrigger(session, filterToSearchParams(filter).toString(), params.get("refresh"));
    const { count, studies, facets, facetAudit, returned } = await listStudies(await screenDeps(session), filter);
    await audit(session, searchAuditFields("api", returned, facetAudit, trigger));
    return Response.json({ count, studies, facets });
  } catch (error) {
    return errorResponse(error);
  }
}
