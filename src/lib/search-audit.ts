import type { AuditFields } from "@/lib/auth/session";
import type { StudySummary } from "@/lib/backend/types";

// 検索の監査の記録（docs/spec.md の 3.6、第7.0版 17 遵守事項①）。
// 件数だけでは、誰がどの患者・検査の情報を見たかを後から追えない（画像サーバーの中身は変わる）ので、
// 返した検査の [患者 ID, StudyInstanceUID] の組を、返した順に補足に残す。
// 1 件の検索で 1 行（検査ごとに行を分けない）。上限は検索の上限（STUDY_LIMIT）と同じ。

export function searchAuditFields(via: "page" | "api", studies: StudySummary[]): AuditFields {
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
    },
  };
}
