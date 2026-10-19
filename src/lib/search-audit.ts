import type { AuditFields } from "@/lib/auth/session";
import type { StudySummary } from "@/lib/backend/types";
import type { FacetAudit } from "@/lib/study-list";

// 検索の監査の記録（docs/spec.md の 3.6、第7.0版 17 遵守事項①）。
// 件数だけでは、誰がどの患者・検査の情報を見たかを後から追えない（画像サーバーの中身は変わる）ので、
// 返した検査の [患者 ID, StudyInstanceUID] の組を、返した順に補足に残す。
// 1 件の検索で 1 行（検査ごとに行を分けない）。上限は検索の上限（STUDY_LIMIT）と同じ。

/**
 * `facets`：見出しの件数を数えたときの条件・範囲・件数・上限に届いたか（src/lib/study-list.ts の FacetAudit）。
 * 件数から知れること（例：「今日＋患者 ID」で一覧は 0 件でも、全期間の件数から過去の検査の有無が分かる）を、後から追えるようにする。
 * 患者の値は入れない（検索の語は有無だけ）
 */
export function searchAuditFields(via: "page" | "api", studies: StudySummary[], facets?: FacetAudit): AuditFields {
  const patients = new Set(studies.map((s) => s.patientId));
  return {
    action: "search",
    // 1人の患者の検査だけを返したときは、行の患者の欄にも入れる（患者で記録を探せるように）
    patientId: patients.size === 1 ? [...patients][0]! : null,
    studyInstanceUid: studies.length === 1 ? studies[0]!.studyInstanceUid : null,
    detail: {
      via,
      results: studies.length,
      returned: studies.map((s) => [s.patientId, s.studyInstanceUid]),
      ...(facets ? { facets } : {}),
    },
  };
}
