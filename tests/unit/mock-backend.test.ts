import { describe, expect, it } from "vitest";
import { datasetRows } from "@/lib/all-values";
import { personNameToString, studyDateRange } from "@/lib/backend/dicom-json";
import { createMockBackend } from "@/lib/backend/mock";
import { safeRelayPath, wadoRsTarget, type WadoRsTarget } from "@/lib/backend/relay-path";
import { BackendError, clampStudyLimit, STUDY_LIMIT } from "@/lib/backend/types";

describe("モックのバックエンド", () => {
  it("Orthanc の形：見本の 8 件の検査を新しい順に返し、件数も 8（/statistics の写し）", async () => {
    const backend = createMockBackend();
    expect(backend.kind).toBe("orthanc");
    const studies = await backend.searchStudies();
    expect(studies).toHaveLength(8);
    expect(await backend.countStudies()).toEqual({ count: 8, exact: true });
    const keys = studies.map((s) => s.studyDate + s.studyTime);
    expect(keys).toEqual([...keys].sort().reverse());
    expect(studies.every((s) => s.patientId.startsWith("JP-TEST-"))).toBe(true);
  });

  it("DICOM JSON の値を検査の形にする", async () => {
    const studies = await createMockBackend().searchStudies();
    const study = studies.find((s) => s.accessionNumber === "ACC-0004-1");
    expect(study).toMatchObject({
      studyInstanceUid: "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012",
      patientId: "JP-TEST-0004",
      patientName: "Shiken^Takako=試験^髙子=しけん^たかこ",
      patientBirthDate: "19600715",
      patientSex: "F",
      studyDate: "20260410",
      modalities: ["CT"],
      seriesCount: 1,
      instanceCount: 4,
    });
  });

  it("検索の件数を 1〜1000 に収める", async () => {
    const backend = createMockBackend();
    expect(await backend.searchStudies(3)).toHaveLength(3);
    expect(await backend.searchStudies(0)).toHaveLength(1);
    expect(await backend.searchStudies(-5)).toHaveLength(1);
    expect(await backend.searchStudies(Number.NaN)).toHaveLength(8);
    expect(clampStudyLimit(10_000)).toBe(STUDY_LIMIT);
    expect(clampStudyLimit(2.7)).toBe(2);
    expect(clampStudyLimit(undefined)).toBe(STUDY_LIMIT);
  });

  it("中継：WADO-RS の読み取りの宛先だけを受ける（見本は無いので 404）", async () => {
    const backend = createMockBackend();
    const target = wadoRsTarget(["studies", STUDY, "series", "1.2.3", "metadata"])!;
    const res = await backend.relayDicomweb({ method: "GET", target, search: "" });
    expect(res.status).toBe(404);

    // 確かめを通っていない宛先（検索）は、モックの側でも断る
    await expect(
      backend.relayDicomweb({ method: "GET", target: { path: "studies", studyInstanceUid: "" }, search: "" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      backend.relayDicomweb({ method: "POST" as "GET", target, search: "" }),
    ).rejects.toMatchObject({ status: 405 });
  });
});

const STUDY = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
const SERIES = "1.2.826.0.1.3680043.8.498.1";
const INSTANCE = "1.2.826.0.1.3680043.8.498.2";

describe("中継の path", () => {
  it("使える字だけを通す", () => {
    expect(safeRelayPath(["studies", "1.2.3", "series"])).toBe("studies/1.2.3/series");
    expect(safeRelayPath(["frames", "1,2,3"])).toBe("frames/1,2,3");
    for (const bad of [["studies", "a/b"], ["studies", "a b"], ["studies", ".."], ["studies%2F.."], ["..", "rest"], []]) {
      expect(() => safeRelayPath(bad)).toThrow(BackendError);
    }
  });

  it("WADO-RS の読み取り（取得・metadata・rendered・thumbnail・frames・bulk）を通し、UID を分ける", () => {
    const ok: [string[], Partial<WadoRsTarget>][] = [
      [["studies", STUDY], { studyInstanceUid: STUDY }],
      [["studies", STUDY, "metadata"], { studyInstanceUid: STUDY }],
      [["studies", STUDY, "rendered"], {}],
      [["studies", STUDY, "series", SERIES], { seriesInstanceUid: SERIES }],
      [["studies", STUDY, "series", SERIES, "metadata"], { seriesInstanceUid: SERIES }],
      [["studies", STUDY, "series", SERIES, "thumbnail"], {}],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE], { sopInstanceUid: INSTANCE }],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE, "metadata"], { sopInstanceUid: INSTANCE }],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames", "1"], {}],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames", "1,2,3"], {}],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames", "1", "rendered"], {}],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE, "bulk", "7fe00010"], {}],
      [["studies", STUDY, "series", SERIES, "instances", INSTANCE, "bulk", "00540016", "0", "00181072"], {}],
    ];
    for (const [segments, expected] of ok) {
      const target = wadoRsTarget(segments);
      expect(target, segments.join("/")).not.toBeNull();
      expect(target).toMatchObject({ path: segments.join("/"), ...expected });
    }
  });

  it("検索（QIDO-RS）とほかの path は通さない", () => {
    const rejected = [
      ["studies"],
      ["series"],
      ["instances"],
      ["studies", STUDY, "series"],
      ["studies", STUDY, "instances"],
      ["studies", STUDY, "series", SERIES, "instances"],
      ["studies", "not-a-uid"],
      ["studies", `1.${"2".repeat(64)}`],
      ["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames"],
      ["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames", "0"],
      ["studies", STUDY, "series", SERIES, "instances", INSTANCE, "frames", "1", "metadata"],
      ["studies", STUDY, "series", SERIES, "instances", INSTANCE, "bulk"],
      ["studies", STUDY, "series", SERIES, "instances", INSTANCE, "bulk", "pixeldata"],
      ["studies", STUDY, "metadata", "extra"],
      ["workitems"],
      ["tools", "find"],
    ];
    for (const segments of rejected) expect(wadoRsTarget(segments), segments.join("/")).toBeNull();
  });
});

describe("PN の文字列", () => {
  it("3つの組を = でつなぎ、末尾の空の組は落とす", () => {
    expect(personNameToString({ Alphabetic: "Yamada^Taro", Ideographic: "山田^太郎", Phonetic: "やまだ^たろう" })).toBe(
      "Yamada^Taro=山田^太郎=やまだ^たろう",
    );
    expect(personNameToString({ Alphabetic: "Yamada^Taro" })).toBe("Yamada^Taro");
    expect(personNameToString({ Ideographic: "山田^太郎" })).toBe("=山田^太郎");
  });
});

describe("モックのバックエンド（段 2：検査日の範囲・シリーズ・値の全部・サムネイル）", () => {
  it("検査日の範囲で絞る", async () => {
    const backend = createMockBackend();
    expect(await backend.searchStudies(1000, { dateFrom: "20261017", dateTo: "20261017" })).toHaveLength(4);
    expect(await backend.searchStudies(1000, { dateTo: "20260410" })).toHaveLength(4);
    expect(await backend.searchStudies(1000, { dateFrom: "20261018" })).toHaveLength(0);
    expect(studyDateRange({ dateFrom: "20260401", dateTo: "20260430" })).toBe("20260401-20260430");
    expect(studyDateRange({ dateFrom: "20260401", dateTo: "20260401" })).toBe("20260401");
    expect(studyDateRange({ dateTo: "20260430" })).toBe("-20260430");
    expect(studyDateRange({ dateFrom: "2026-04-01" })).toBeNull();
  });

  it("検査の中のシリーズをシリーズの番号の順に返す", async () => {
    const series = await createMockBackend().searchSeries(STUDY);
    expect(series).toEqual([
      {
        seriesInstanceUid: "1.2.826.0.1.3680043.8.498.43907805789171690229100828585828292254",
        modality: "CT",
        seriesNumber: "1",
        seriesDescription: "Chest Axial 5mm",
        bodyPartExamined: "CHEST",
        seriesDate: "20260410",
        instanceCount: 4,
      },
    ]);
    expect(await createMockBackend().searchSeries("1.2.3")).toEqual([]);
    // 見本の全部のシリーズ（10）が、どれかの検査に入る
    const studies = await createMockBackend().searchStudies();
    const all = await Promise.all(studies.map((s) => createMockBackend().searchSeries(s.studyInstanceUid)));
    expect(all.flat()).toHaveLength(10);
  });

  it("1件の検査の値の全部（タグの順の行にする）", async () => {
    const ds = await createMockBackend().studyDataset(STUDY);
    expect(ds).not.toBeNull();
    const rows = datasetRows(ds!);
    expect(rows.map((r) => r.tag)).toEqual([...rows.map((r) => r.tag)].sort());
    expect(rows).toContainEqual({ tag: "0010,0020", vr: "LO", value: "JP-TEST-0004" });
    expect(await createMockBackend().studyDataset("1.2.3")).toBeNull();
  });

  it("値の全部の行：シーケンス・バイナリ・複数の値・形の誤ったキー", () => {
    expect(
      datasetRows({
        "00081115": { vr: "SQ", Value: [{}, {}] },
        "7FE00010": { vr: "OB", BulkDataURI: "https://pacs.example.org/x" },
        "00080008": { vr: "CS", Value: ["ORIGINAL", "PRIMARY"] },
        "<script>": { vr: "LO", Value: ["x"] },
      }),
    ).toEqual([
      { tag: "0008,0008", vr: "CS", value: "ORIGINAL\\PRIMARY" },
      { tag: "0008,1115", vr: "SQ", value: "（シーケンス 2 件）" },
      { tag: "7FE0,0010", vr: "OB", value: "（バイナリ）" },
    ]);
  });

  it("中継：写しのある画像の検査・シリーズのサムネイルだけを PNG で返す", async () => {
    const backend = createMockBackend();
    // 写しのある1枚（rest/instances/…/preview.png）の検査を、見本から探す
    const studies = await backend.searchStudies();
    let found: { study: string; series: string } | null = null;
    for (const s of studies) {
      for (const se of await backend.searchSeries(s.studyInstanceUid)) {
        const target = wadoRsTarget(["studies", s.studyInstanceUid, "series", se.seriesInstanceUid, "thumbnail"])!;
        const res = await backend.relayDicomweb({ method: "GET", target, search: "" });
        if (res.status === 200) {
          expect(res.headers.get("content-type")).toBe("image/png");
          const bytes = new Uint8Array(await res.arrayBuffer());
          expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
          found = { study: s.studyInstanceUid, series: se.seriesInstanceUid };
        }
      }
    }
    expect(found).not.toBeNull();
    const study = wadoRsTarget(["studies", found!.study, "thumbnail"])!;
    expect((await backend.relayDicomweb({ method: "GET", target: study, search: "" })).status).toBe(200);
    const other = wadoRsTarget(["studies", STUDY, "thumbnail"])!;
    if (found!.study !== STUDY) expect((await backend.relayDicomweb({ method: "GET", target: other, search: "" })).status).toBe(404);
  });
});
