import { describe, expect, it } from "vitest";
import { matchesStudyQuery, studyQueryParams } from "@/lib/backend/dicom-json";
import { createMockBackend } from "@/lib/backend/mock";
import type { StudyQuery, StudySummary } from "@/lib/backend/types";
import { ROLE_FIELD_ALLOWLIST } from "@/lib/fields";
import { advancedCount, advancedQuery, filterToSearchParams, parseFilter } from "@/lib/study-filter";
import { listStudies } from "@/lib/study-list";

// 詳細条件（docs/spec.md の 3.1。2026-10-21）：生年月日・性別・受付番号・検査名・依頼医。
// Orthanc の QIDO-RS の条件にし（上限 1000 件の外の古い検査も引ける）、BFF でも答えを確かめる。
// 許可の一覧に載っていない項目の条件は効かせない（原則 8）。

const ALL = ROLE_FIELD_ALLOWLIST.general.study;

describe("URL の値を読む", () => {
  it("生年月日・性別・受付番号・検査名・依頼医を読み、同じ形で書き戻す", () => {
    const filter = parseFilter(
      new URLSearchParams({ birth: "1975-05-10", sex: "F", accession: " ACC-0001 ", desc: "Chest CT", referring: "佐藤 一郎" }),
    );
    expect(filter).toEqual({ date: "all", birth: "1975-05-10", sex: "F", accession: "ACC-0001", desc: "Chest CT", referring: "佐藤 一郎" });
    expect(advancedCount(filter)).toBe(5);
    expect(parseFilter(filterToSearchParams(filter))).toEqual(filter);
  });

  it("読めない値は条件にしない：日付の形・性別の値・ワイルドカードと区切りの字・制御文字・長すぎる値", () => {
    const bad = parseFilter(
      new URLSearchParams({ birth: "1975-13-40", sex: "X", accession: "ACC*", desc: "a?b", referring: "a\\b" }),
    );
    expect(bad).toEqual({ date: "all" });
    expect(parseFilter(new URLSearchParams({ accession: "A,B" }))).toEqual({ date: "all" });
    expect(parseFilter(new URLSearchParams({ desc: "a\u0000b" }))).toEqual({ date: "all" });
    expect(parseFilter(new URLSearchParams({ desc: "x".repeat(65) }))).toEqual({ date: "all" });
    expect(parseFilter(new URLSearchParams({ desc: "x".repeat(64) })).desc).toHaveLength(64);
    expect(parseFilter(new URLSearchParams({ sex: "m" }))).toEqual({ date: "all" });
  });
});

describe("画像サーバーへ渡す条件", () => {
  it("生年月日・性別は一致、文字の条件は含むもの（空白で区切った語は、その順に）", () => {
    const query = advancedQuery({ date: "all", birth: "1975-05-10", sex: "M", accession: "ACC-0001", desc: "Chest CT", referring: "佐藤 一郎" }, ALL);
    expect(query).toEqual({
      patientBirthDate: "19750510",
      patientSex: "M",
      accessionNumber: "ACC-0001",
      studyDescription: "Chest CT",
      referringPhysicianName: "佐藤 一郎",
    });
    expect(studyQueryParams(query)).toEqual([
      ["PatientBirthDate", "19750510"],
      ["PatientSex", "M"],
      ["AccessionNumber", "*ACC-0001*"],
      ["StudyDescription", "*Chest*CT*"],
      ["ReferringPhysicianName", "*佐藤*一郎*"],
    ]);
  });

  it("許可の一覧に載っていない項目の条件は効かせない（隠した項目で探せないように）", () => {
    const filter = { date: "all" as const, birth: "1975-05-10", sex: "M" as const, accession: "A", desc: "B", referring: "C" };
    expect(advancedQuery(filter, ["studyInstanceUid", "patientSex"])).toEqual({ patientSex: "M" });
    expect(advancedQuery(filter, [])).toEqual({});
  });
});

describe("答えの確かめ（BFF でも、条件に合わない検査を返さない）", () => {
  const study: StudySummary = {
    studyInstanceUid: "1.2.3",
    patientId: "JP-TEST-0001",
    patientName: "Yamada^Taro=山田^太郎=やまだ^たろう",
    patientBirthDate: "19750510",
    patientSex: "M",
    studyDate: "20261017",
    studyTime: "093000",
    accessionNumber: "ACC-0001-2",
    studyDescription: "Chest CT plain",
    studyId: "1",
    referringPhysicianName: "Sato^Ichiro=佐藤^一郎=さとう^いちろう",
    modalities: ["CT"],
    seriesCount: 1,
    instanceCount: 2,
  };
  const ok = (query: StudyQuery) => matchesStudyQuery(study, query);

  it("生年月日・性別は一致", () => {
    expect(ok({ patientBirthDate: "19750510", patientSex: "M" })).toBe(true);
    expect(ok({ patientBirthDate: "19750511" })).toBe(false);
    expect(ok({ patientSex: "F" })).toBe(false);
  });

  it("文字の条件は、全角と半角・大文字と小文字を区別せずに、語をその順に含むか", () => {
    expect(ok({ accessionNumber: "0001" })).toBe(true);
    expect(ok({ accessionNumber: "ＡＣＣ－０００１" })).toBe(true);
    expect(ok({ studyDescription: "chest" })).toBe(true);
    expect(ok({ studyDescription: "chest plain" })).toBe(true);
    expect(ok({ studyDescription: "plain chest" })).toBe(false);
    expect(ok({ referringPhysicianName: "佐藤 一郎" })).toBe(true);
    expect(ok({ referringPhysicianName: "sato" })).toBe(true);
    expect(ok({ referringPhysicianName: "田中" })).toBe(false);
  });

  it("検査日の範囲と一緒に当てる", () => {
    expect(ok({ dateFrom: "20261017", accessionNumber: "ACC" })).toBe(true);
    expect(ok({ dateFrom: "20261018", accessionNumber: "ACC" })).toBe(false);
  });
});

describe("検査の一覧（モック）", () => {
  const deps = (backend = createMockBackend()) => ({ backend, role: "general" as const, actorId: "dev", timeZone: "Asia/Tokyo" });

  it("詳細条件で絞り、件数の見出しも同じ条件で数える。監査の記録には条件の名前だけを残す", async () => {
    const all = await listStudies(deps(), { date: "all" });
    const birth = await listStudies(deps(), { date: "all", birth: "1975-05-10" });
    expect(birth.studies.map((s) => s.patientId)).toEqual(["JP-TEST-0001", "JP-TEST-0001"]);
    expect(birth.facets.modality!.all).toBe(2);
    const female = await listStudies(deps(), { date: "all", sex: "F" });
    expect(female.count.count).toBe(all.studies.filter((s) => s.patientSex === "F").length);
    expect((await listStudies(deps(), { date: "all", accession: "ACC-0004-2" })).studies).toHaveLength(1);
    expect((await listStudies(deps(), { date: "all", referring: "試験 医師" })).count.count).toBe(all.count.count);
    expect((await listStudies(deps(), { date: "all", referring: "佐藤" })).count.count).toBe(0);
    expect(birth.facetAudit.filter).toEqual({ date: "all", query: false, conditions: ["patientBirthDate"] });
    expect(JSON.stringify(birth.facetAudit)).not.toContain("1975");
  });

  it("検査日の件数のための追加の検索にも、詳細条件を当てる（検査日だけを外す）", async () => {
    const seen: (StudyQuery | undefined)[] = [];
    const mock = createMockBackend();
    const backend = { ...mock, searchStudies: (limit?: number, query?: StudyQuery) => (seen.push(query), mock.searchStudies(limit, query)) };
    const result = await listStudies(deps(backend), { date: "range", from: "2026-10-17", to: "2026-10-17", sex: "M" });
    expect(seen).toEqual([
      { dateFrom: "20261017", dateTo: "20261017", patientSex: "M" },
      { patientSex: "M" },
    ]);
    // 「すべて」の件数は、押したあとの一覧（全期間・男）の件数と同じ
    expect(result.facets.date!.all).toBe((await listStudies(deps(), { date: "all", sex: "M" })).count.count);
  });
});
