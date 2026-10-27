import { describe, expect, it } from "vitest";
import type { StudySummary } from "@/lib/backend/types";
import { ROLE_FIELD_ALLOWLIST, type FieldAllowlistMap } from "@/lib/fields";
import { listStudies } from "@/lib/study-list";

// 横断の検索（docs/spec.md の 3.1）：患者 ID・受付番号は全体の一致、氏名は第3〜5成分まで含めて当てる（画面に出す値は姓と名のまま）。

function summary(i: number, extra: Partial<StudySummary> = {}): StudySummary {
  return {
    studyInstanceUid: `1.2.3.${i}`,
    patientId: `P-${i}`,
    patientName: "Yamada^Taro",
    patientBirthDate: "19700101",
    patientSex: "M",
    studyDate: "20261019",
    studyTime: "090000",
    accessionNumber: `ACC-${i}`,
    studyDescription: "",
    studyId: "",
    referringPhysicianName: "",
    modalities: ["CT"],
    seriesCount: 1,
    instanceCount: 1,
    ...extra,
  };
}

const all = [
  summary(1, { patientId: "025" }),
  summary(2, { patientId: "1025" }),
  summary(3, { patientId: "0257", accessionNumber: "025" }),
  summary(4, { patientName: "Doe^John^Michael^Dr^Jr.=ドウ^ジョン^^^=どう^じょん" }),
];

const deps = (role: "admin" | "general" = "general", allowlists?: FieldAllowlistMap) => ({
  backend: { searchStudies: async () => ({ studies: all, complete: true }) } as never,
  role,
  actorId: "a",
  now: new Date("2026-10-19T03:00:00Z"),
  timeZone: "Asia/Tokyo",
  allowlists,
});

const uids = async (q: string, role: "admin" | "general" = "general", allowlists?: FieldAllowlistMap) =>
  (await listStudies(deps(role, allowlists), { date: "all", q })).studies.map((s) => s.studyInstanceUid);

describe("横断の検索：患者 ID・受付番号は全体の一致", () => {
  it("「025」は、患者 ID が 025 の検査と、受付番号が 025 の検査だけに合う（「1025」「0257」には合わない）", async () => {
    expect(await uids("025")).toEqual(["1.2.3.1", "1.2.3.3"]);
  });

  it("件数も同じ数で数える", async () => {
    const result = await listStudies(deps(), { date: "all", q: "025" });
    expect(result.count.count).toBe(2);
    expect(result.facets.modality?.all).toBe(2);
    expect(result.facets.date?.all).toBe(2);
  });
});

describe("横断の検索：氏名は第3〜5成分まで含める", () => {
  it.each(["Michael", "Dr", "Jr.", "John Michael", "doe john michael dr jr."])("「%s」で見つかる", async (q) => {
    expect(await uids(q)).toEqual(["1.2.3.4"]);
  });

  it("画面の API に返す氏名は、姓と名のまま（検索の値を返さない）", async () => {
    const [found] = (await listStudies(deps(), { date: "all", q: "Michael" })).studies;
    expect(found?.patientName).toBe("ドウ ジョン");
    expect(found?.patientKana).toBe("どう じょん");
    expect(found?.patientNameAlphabetic).toBe("Doe John");
    expect(JSON.stringify(found)).not.toContain("Michael");
    expect(JSON.stringify(found)).not.toContain("Jr.");
  });

  it("許可の一覧に氏名が無い役割では、第3〜5成分でも氏名では探せない", async () => {
    const noName: FieldAllowlistMap = {
      ...ROLE_FIELD_ALLOWLIST,
      general: {
        ...ROLE_FIELD_ALLOWLIST.general,
        study: ROLE_FIELD_ALLOWLIST.general.study.filter((f) => !["patientName", "patientKana", "patientNameAlphabetic"].includes(f)),
      },
    };
    expect(await uids("Michael", "general", noName)).toEqual([]);
    expect(await uids("ジョン", "general", noName)).toEqual([]);
  });
});
