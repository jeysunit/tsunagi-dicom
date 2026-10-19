import { describe, expect, it } from "vitest";
import { createMockBackend } from "@/lib/backend/mock";
import { searchAuditFields } from "@/lib/search-audit";

// 検索の監査の記録：返した検査（患者 ID と StudyInstanceUID の組）を、返したものと同じだけ残す。

describe("検索の監査の記録", () => {
  it("返した検査の組を、返した順にすべて残す", async () => {
    const studies = await createMockBackend().searchStudies();
    const fields = searchAuditFields("api", studies);
    expect(fields.action).toBe("search");
    const detail = fields.detail as { via: string; results: number; returned: [string, string][] };
    expect(detail.via).toBe("api");
    expect(detail.results).toBe(8);
    expect(detail.returned).toEqual(studies.map((s) => [s.patientId, s.studyInstanceUid]));
    // 複数の患者なら、行の患者・検査の欄は空（補足の組で探す）
    expect(fields.patientId).toBeNull();
    expect(fields.studyInstanceUid).toBeNull();
  });

  it("1人の患者・1件の検査だけを返したときは、行の欄にも入れる", async () => {
    const [first] = await createMockBackend().searchStudies(1);
    const fields = searchAuditFields("page", [first!]);
    expect(fields).toMatchObject({ patientId: first!.patientId, studyInstanceUid: first!.studyInstanceUid });
  });

  it("何も返さなかったときは、組も空", () => {
    expect(searchAuditFields("page", [])).toMatchObject({
      patientId: null,
      studyInstanceUid: null,
      detail: { results: 0, returned: [] },
    });
  });
});
