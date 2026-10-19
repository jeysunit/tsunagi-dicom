import { describe, expect, it } from "vitest";
import { ROLE_FIELD_ALLOWLIST, STUDY_FIELDS, type StudyView } from "@/lib/fields";
import { MODALITY_GROUPS } from "@/lib/modalities";
import { matchesFilter, type StudyFilter } from "@/lib/study-filter";
import { computeFacets } from "@/lib/study-list";

// 見出しごとの件数（BFF が数える。docs/spec.md の 3.1）。各件数は「その見出しを押したあとの一覧の件数」と同じ。
// 許可の一覧に載っていない項目の件数は、キーごと出さない（原則 8）。
// 段 3 で検査の状態の見出しを外したので、件数は検査日とモダリティだけ。

const today = { year: 2026, month: 10, day: 19 };
const ALL_FIELDS: readonly string[] = STUDY_FIELDS;

const view = (extra: Partial<StudyView>): StudyView => ({
  studyInstanceUid: "1.2.3",
  patientId: "JP-TEST-0001",
  patientName: "山田 太郎",
  studyDate: "20261019",
  modalities: ["CT"],
  ...extra,
});

const views: StudyView[] = [
  view({ studyDate: "20261019", modalities: ["CT"] }),
  view({ studyDate: "20261019", modalities: ["MR"] }),
  view({ studyDate: "20261018", modalities: ["DX", "SR"] }),
  view({ studyDate: "20261001", modalities: ["CT"] }),
  view({ studyDate: "20260101", modalities: ["US"], patientName: "佐藤 花子" }),
];
const dateOf = (filter: StudyFilter) => (v: StudyView) => v.studyDate! >= (filter.date === "today" ? "20261019" : "00000000");

describe("見出しの件数", () => {
  it("全部の見出しで、件数は押したあとの一覧の件数と同じ（ほかの見出しと検索は、いまの値のまま）", () => {
    const filters: StudyFilter[] = [{ date: "all" }, { date: "all", modality: "CT" }, { date: "all", q: "山田" }, { date: "all", modality: "CT", q: "山田" }];
    for (const filter of filters) {
      const f = computeFacets(views, views, filter, today, ALL_FIELDS);
      expect(f.modality!.all).toBe(views.filter((v) => matchesFilter(v, { ...filter, modality: undefined })).length);
      for (const g of MODALITY_GROUPS) {
        expect(f.modality![g]).toBe(views.filter((v) => matchesFilter(v, { ...filter, modality: g })).length);
      }
    }
  });

  it("検査日の件数は、検査日で絞らない一覧を元に、モダリティ・検索を当てて数える", () => {
    // いまの一覧は「今日」だけ。検査日の件数は全期間の元（dateViews）から数える
    const nowList = views.filter(dateOf({ date: "today" }));
    const f = computeFacets(nowList, views, { date: "today", modality: "CT" }, today, ALL_FIELDS);
    expect(f.date).toEqual({ today: 1, yesterday: 0, week: 1, month: 2, all: 2 });
    const g = computeFacets(nowList, views, { date: "today" }, today, ALL_FIELDS);
    expect(g.date).toEqual({ today: 2, yesterday: 1, week: 3, month: 4, all: 5 });
  });

  it("許可の一覧に載っていない項目の見出しは、キーごと出さない", () => {
    const only = (...fields: string[]) => computeFacets(views, views, { date: "all" }, today, fields);
    expect(only()).toEqual({});
    expect(Object.keys(only("studyDate"))).toEqual(["date"]);
    expect(Object.keys(only("modalities"))).toEqual(["modality"]);
  });

  it("見えない項目の値は、件数にも漏れない：許可の一覧で絞った後の項目だけを数える", () => {
    // 閲覧の想定（検査日だけ）。モダリティは view に無いので、数えない
    const narrow = views.map((v) => ({ studyInstanceUid: v.studyInstanceUid, studyDate: v.studyDate }));
    const f = computeFacets(narrow, narrow, { date: "all" }, today, ["studyInstanceUid", "studyDate"]);
    expect(f).toEqual({ date: { today: 2, yesterday: 1, week: 3, month: 4, all: 5 } });
  });

  it("既定の役割は、どれも全部の見出しの件数を見る。一覧に無い役割は何も見ない", () => {
    for (const role of ["admin", "doctor", "technologist", "viewer"] as const) {
      const f = computeFacets(views, views, { date: "all" }, today, ROLE_FIELD_ALLOWLIST[role].study);
      expect(Object.keys(f).sort()).toEqual(["date", "modality"]);
    }
    expect(computeFacets(views, views, { date: "all" }, today, [])).toEqual({});
  });
});
