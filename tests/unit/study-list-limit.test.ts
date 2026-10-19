import { describe, expect, it, vi } from "vitest";
import { inDateRange } from "@/lib/backend/dicom-json";
import type { StudyQuery, StudySummary } from "@/lib/backend/types";
import { STUDY_LIMIT } from "@/lib/backend/types";
import { ROLE_FIELD_ALLOWLIST, type FieldAllowlistMap } from "@/lib/fields";
import { searchAuditFields } from "@/lib/search-audit";
import { listStudies } from "@/lib/study-list";

// 検査日の件数のための追加の検索（docs/spec.md の 3.1）：上限（1000 件）に届いたときの「以上」・呼び出しの回数と上限・
// 失敗したときの扱い（件数だけを出さず、一覧は出す）・監査の記録の補足。

const NOW = new Date("2026-10-19T03:00:00Z"); // 日本時間 2026-10-19

function summary(i: number, date: string, extra: Partial<StudySummary> = {}): StudySummary {
  return {
    studyInstanceUid: `1.2.3.${i}`,
    patientId: `P-${i}`,
    patientName: "山田 太郎",
    patientBirthDate: "19700101",
    patientSex: "M",
    studyDate: date,
    studyTime: "090000",
    accessionNumber: "",
    studyDescription: "",
    studyId: "",
    referringPhysicianName: "",
    modalities: ["CT"],
    seriesCount: 1,
    instanceCount: 1,
    ...extra,
  };
}

/** 新しい順に並べた検査から、日付の範囲で絞って limit 件まで返す偽の画像サーバー */
function fakeBackend(all: StudySummary[], behavior: (call: number, query: StudyQuery | undefined) => void = () => undefined) {
  let calls = 0;
  const searchStudies = vi.fn(async (limit?: number, query?: StudyQuery) => {
    behavior(++calls, query);
    return all.filter((s) => inDateRange(s.studyDate, query)).slice(0, limit);
  });
  return { backend: { searchStudies }, searchStudies };
}

const deps = (backend: { searchStudies: ReturnType<typeof vi.fn> }, extra: Record<string, unknown> = {}) => ({
  backend: backend as never,
  role: "doctor" as const,
  actorId: "a",
  now: NOW,
  timeZone: "Asia/Tokyo",
  ...extra,
});

describe("上限に届いた検索の件数", () => {
  it("1000 件を超える検査があっても、数えきれた見出しは確定、数えきれていない見出しだけ「以上」", async () => {
    // 今日が 3 件、昨日以外の 10/01 より前が 1197 件（新しい順に並べる）
    const all = [
      ...Array.from({ length: 3 }, (_, i) => summary(i, "20261019")),
      ...Array.from({ length: 1197 }, (_, i) => summary(100 + i, "20260901")),
    ];
    const { backend, searchStudies } = fakeBackend(all);
    const r = await listStudies(deps(backend), { date: "today" });
    expect(r.count).toEqual({ count: 3, exact: true });
    expect(searchStudies).toHaveBeenCalledTimes(2);
    // 全期間の検索は上限に届いた：全期間は「以上」。今日・昨日・1週間・今月は、読んだ範囲に全部入っているので確定
    expect(r.facets.date).toMatchObject({ today: 3, yesterday: 0, week: 3, month: 3, all: 1000 });
    expect(r.facets.atLeast).toEqual({ date: ["all"] });
    expect(r.facetAudit).toMatchObject({ limited: true, fetched: STUDY_LIMIT, atLeast: true });
  });

  it("上限の中に範囲が入りきらない見出しは「以上」にする（「昨日 (0)」と出して、押すと出る、を起こさない）", async () => {
    // 昨日が 1100 件（上限を超える）。全期間の検索は昨日の 1000 件で終わり、昨日のぶんの件数は不確定
    const all = [
      ...Array.from({ length: 1100 }, (_, i) => summary(i, "20261018")),
      ...Array.from({ length: 50 }, (_, i) => summary(2000 + i, "20260101")),
    ];
    const { backend } = fakeBackend(all);
    const r = await listStudies(deps(backend), { date: "today" });
    expect(r.count).toEqual({ count: 0, exact: true });
    // 今日（昨日より新しい）は確定の 0。昨日・1週間・今月・全期間は 1000 以上
    expect(r.facets.date).toMatchObject({ today: 0, yesterday: 1000, week: 1000, month: 1000, all: 1000 });
    expect(r.facets.atLeast?.date?.sort()).toEqual(["all", "month", "week", "yesterday"]);
  });

  it("いまの一覧が上限に届いたときは、モダリティ・状態の件数も「以上」", async () => {
    const all = Array.from({ length: 1200 }, (_, i) => summary(i, "20261018"));
    const { backend } = fakeBackend(all);
    const r = await listStudies(deps(backend), { date: "all" });
    expect(r.count).toEqual({ count: 1000, exact: false });
    expect(r.facets.atLeast?.list).toBe(true);
    expect(r.facets.modality?.CT).toBe(1000);
  });

  it("上限に届かなければ、全部が確定（atLeast は無い）", async () => {
    const all = Array.from({ length: 10 }, (_, i) => summary(i, i < 5 ? "20261019" : "20260101"));
    const { backend } = fakeBackend(all);
    const r = await listStudies(deps(backend), { date: "today" });
    expect(r.facets.atLeast).toBeUndefined();
    expect(r.facets.date).toMatchObject({ today: 5, all: 10 });
    expect(r.facetAudit).toMatchObject({ limited: false, atLeast: false });
  });
});

describe("追加の検索", () => {
  const all = [summary(1, "20261019"), summary(2, "20260101")];

  it("検査日が全期間なら 1 回、全期間でなければ 2 回（2 回目は上限 1000 件・日付の条件なし）", async () => {
    const a = fakeBackend(all);
    await listStudies(deps(a.backend), { date: "all" });
    expect(a.searchStudies).toHaveBeenCalledTimes(1);

    const b = fakeBackend(all);
    await listStudies(deps(b.backend), { date: "today" });
    expect(b.searchStudies).toHaveBeenCalledTimes(2);
    expect(b.searchStudies.mock.calls[0]).toEqual([STUDY_LIMIT, { dateFrom: "20261019", dateTo: "20261019" }]);
    expect(b.searchStudies.mock.calls[1]).toEqual([STUDY_LIMIT, {}]);

    const c = fakeBackend(all);
    await listStudies(deps(c.backend), { date: "range", from: "2026-10-01", to: "2026-10-31" });
    expect(c.searchStudies).toHaveBeenCalledTimes(2);
    expect(c.searchStudies.mock.calls[1]).toEqual([STUDY_LIMIT, {}]);
  });

  it("検査日を許されていない役割は、追加の検索をしない（検査日の絞り込みも件数も効かせない）", async () => {
    const allowlists: FieldAllowlistMap = { ...ROLE_FIELD_ALLOWLIST, viewer: { study: ["studyInstanceUid", "modalities"], series: [] } };
    const { backend, searchStudies } = fakeBackend(all);
    const r = await listStudies(deps(backend, { role: "viewer", allowlists }), { date: "today" });
    expect(searchStudies).toHaveBeenCalledTimes(1);
    expect(searchStudies.mock.calls[0]).toEqual([STUDY_LIMIT, {}]);
    expect(r.facets.date).toBeUndefined();
    expect(r.facetAudit).toMatchObject({ extraSearch: false, dateScope: "none" });
  });

  it("追加の検索が失敗したら、検査日の件数だけを出さず、一覧とほかの件数は出す", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { backend } = fakeBackend(all, (call) => {
      if (call === 2) throw new Error("画像サーバーに届かない: secret-host.example");
    });
    const r = await listStudies(deps(backend), { date: "today" });
    expect(r.studies).toHaveLength(1);
    expect(r.count).toEqual({ count: 1, exact: true });
    expect(r.facets.date).toBeUndefined();
    expect(r.facets.modality?.all).toBe(1);
    expect(r.facets.status).toBeDefined();
    expect(r.facetAudit).toMatchObject({ failed: true, dateScope: "none", extraSearch: true });
    // 失敗の記録は、エラーの名前だけ（メッセージの中の宛先などは出さない）
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret-host");
    error.mockRestore();
  });

  it("最初の検索が失敗したら、これまでどおり一覧ごと失敗する", async () => {
    const { backend } = fakeBackend(all, (call) => {
      if (call === 1) throw new Error("x");
    });
    await expect(listStudies(deps(backend), { date: "today" })).rejects.toThrow("x");
  });
});

describe("件数を数えたことの監査の記録", () => {
  it("数えた条件・範囲・返した件数・上限に届いたかを残す。患者の値は入れない（検索の語は有無だけ）", async () => {
    const all = [summary(1, "20261019", { patientId: "SECRET-ID-9", patientName: "秘密 花子" }), summary(2, "20260101")];
    const { backend } = fakeBackend(all);
    const r = await listStudies(deps(backend), { date: "today", modality: "CT", q: "SECRET-ID-9" });
    const fields = searchAuditFields("api", r.returned, r.facetAudit);
    const detail = fields.detail as { facets: Record<string, unknown>; returned: unknown[] };
    expect(detail.facets).toMatchObject({
      dateScope: "all-dates",
      extraSearch: true,
      fetched: 2,
      limited: false,
      failed: false,
      atLeast: false,
      filter: { date: "today", modality: "CT", query: true },
      counts: { date: { today: 1, all: 1 } },
    });
    // 件数の側の記録に、検索の語・患者の値は入らない（返した検査の組は、これまでどおり returned に残る）
    const facetsText = JSON.stringify(detail.facets);
    expect(facetsText).not.toContain("SECRET-ID-9");
    expect(facetsText).not.toContain("秘密");
    expect(detail.returned).toHaveLength(1);
  });

  it("一覧が 0 件でも、件数を数えたことが残る（今日＋患者 ID で 0 件、全期間では 1 件、が追える）", async () => {
    const all = [summary(1, "20260101", { patientId: "OLD-1" })];
    const { backend } = fakeBackend(all);
    const r = await listStudies(deps(backend), { date: "today", q: "OLD-1" });
    expect(r.returned).toHaveLength(0);
    const detail = searchAuditFields("page", r.returned, r.facetAudit).detail as { facets: { counts: { date: Record<string, number> }; filter: { query: boolean } } };
    expect(detail.facets.counts.date).toMatchObject({ today: 0, all: 1 });
    expect(detail.facets.filter.query).toBe(true);
  });

  it("件数を渡さない呼び出しは、これまでの形のまま", () => {
    expect((searchAuditFields("api", []).detail as Record<string, unknown>).facets).toBeUndefined();
  });
});
