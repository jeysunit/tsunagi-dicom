import { describe, expect, it } from "vitest";
import { datasetRows } from "@/lib/all-values";
import { personNameToString, studyDateRange } from "@/lib/backend/dicom-json";
import { createMockBackend } from "@/lib/backend/mock";
import { safeRelayPath, wadoRsTarget, withRelayAccept, type WadoRsTarget } from "@/lib/backend/relay-path";
import { BackendError, clampStudyLimit, STUDY_LIMIT } from "@/lib/backend/types";

describe("モックのバックエンド", () => {
  it("Orthanc の形：見本の 8 件の検査を新しい順に返し、件数も 8（/statistics の写し）", async () => {
    const backend = createMockBackend();
    expect(backend.kind).toBe("orthanc");
    const { studies, complete } = await backend.searchStudies();
    expect(studies).toHaveLength(8);
    expect(complete).toBe(true);
    expect(await backend.countStudies()).toEqual({ count: 8, exact: true });
    const keys = studies.map((s) => s.studyDate + s.studyTime);
    expect(keys).toEqual([...keys].sort().reverse());
    expect(studies.every((s) => s.patientId.startsWith("JP-TEST-"))).toBe(true);
  });

  it("DICOM JSON の値を検査の形にする", async () => {
    const { studies } = await createMockBackend().searchStudies();
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
    expect(await backend.searchStudies(3)).toMatchObject({ studies: { length: 3 }, complete: false });
    expect((await backend.searchStudies(0)).studies).toHaveLength(1);
    expect((await backend.searchStudies(-5)).studies).toHaveLength(1);
    expect(await backend.searchStudies(Number.NaN)).toMatchObject({ studies: { length: 8 }, complete: true });
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
    expect((await backend.searchStudies(1000, { dateFrom: "20261017", dateTo: "20261017" })).studies).toHaveLength(4);
    expect((await backend.searchStudies(1000, { dateTo: "20260410" })).studies).toHaveLength(4);
    expect((await backend.searchStudies(1000, { dateFrom: "20261018" })).studies).toHaveLength(0);
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
    const { studies } = await createMockBackend().searchStudies();
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
    const { studies } = await backend.searchStudies();
    let found: { study: string; series: string } | null = null;
    for (const s of studies) {
      for (const se of await backend.searchSeries(s.studyInstanceUid)) {
        const target = wadoRsTarget(["studies", s.studyInstanceUid, "series", se.seriesInstanceUid, "thumbnail"])!;
        const res = await backend.relayDicomweb({ method: "GET", target, search: "", accept: "image/png" });
        if (res.status === 200) {
          expect(res.headers.get("content-type")).toBe("image/png");
          const bytes = new Uint8Array(await res.arrayBuffer());
          expect([...bytes.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
          found = { study: s.studyInstanceUid, series: se.seriesInstanceUid };
          // image/jpeg を求めたら JPEG を返す（PNG を返さない。Accept が無いときも、rendered の既定の image/jpeg）
          for (const accept of ["image/jpeg", undefined]) {
            const jpeg = await backend.relayDicomweb({ method: "GET", target, search: "", accept });
            expect(jpeg.headers.get("content-type")).toBe("image/jpeg");
            expect([...new Uint8Array(await jpeg.arrayBuffer()).slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
          }
        }
      }
    }
    expect(found).not.toBeNull();
    const study = wadoRsTarget(["studies", found!.study, "thumbnail"])!;
    expect((await backend.relayDicomweb({ method: "GET", target: study, search: "" })).status).toBe(200);
    const other = wadoRsTarget(["studies", STUDY, "thumbnail"])!;
    if (found!.study !== STUDY) expect((await backend.relayDicomweb({ method: "GET", target: other, search: "" })).status).toBe(404);
  });

  it("中継：thumbnail・rendered は、受け付けない Accept（ブラウザの <img> の Accept）に 400。BFF が決めた Accept なら通る", async () => {
    const backend = createMockBackend();
    let target: WadoRsTarget | null = null;
    for (const s of (await backend.searchStudies()).studies) {
      for (const se of await backend.searchSeries(s.studyInstanceUid)) {
        const t = wadoRsTarget(["studies", s.studyInstanceUid, "series", se.seriesInstanceUid, "thumbnail"])!;
        if ((await backend.relayDicomweb({ method: "GET", target: t, search: "" })).status === 200) target = t;
      }
    }
    expect(target).not.toBeNull();
    const imgAccept = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
    const res = await backend.relayDicomweb({ method: "GET", target: target!, search: "", accept: imgAccept });
    expect(res.status).toBe(400);
    for (const accept of ["image/jpeg", "image/png"]) {
      expect((await backend.relayDicomweb({ method: "GET", target: target!, search: "", accept })).status).toBe(200);
    }
    // metadata など、サムネイルでない道はブラウザの Accept で断らない（見本が無いので 404）
    const metadata = wadoRsTarget(["studies", STUDY, "metadata"])!;
    expect((await backend.relayDicomweb({ method: "GET", target: metadata, search: "", accept: imgAccept })).status).toBe(404);

    // 画面の経路（withRelayAccept を通す）では、同じブラウザの Accept でもサムネイルが出る
    const viaBff = withRelayAccept(backend);
    expect((await viaBff.relayDicomweb({ method: "GET", target: target!, search: "", accept: imgAccept })).status).toBe(200);
  });
});

describe("モックのバックエンド（段 4：受け取りの記録・機器・C-ECHO・送る）", () => {
  it("期間の中で受け取った検査を、新しい順に上限まで返す（見本の 8 件。REST で入った1件は送ってきた機器が無い）", async () => {
    const backend = createMockBackend();
    // 見本の受信の日（2026-10-17。Asia/Tokyo の 0 時から翌日の 0 時まで）
    const day = { fromMs: Date.parse("2026-10-16T15:00:00Z"), toMs: Date.parse("2026-10-17T15:00:00Z") };
    // モックの /changes は 1 回に 5 件までしか返さない（実の Orthanc の切り詰めの形）。区切りごとに Last から続けて読む
    const { studies: all, overLimit, complete } = await backend.receivedStudies({ ...day, limit: 1000 });
    expect({ overLimit, complete }).toEqual({ overLimit: false, complete: true });
    expect(all).toHaveLength(8);
    expect(all.map((r) => r.receivedAt)).toEqual([...all.map((r) => r.receivedAt)].sort().reverse());
    expect(all[0]).toMatchObject({ remoteAet: "DTG_SCU", origin: "DicomProtocol", instanceCount: 6, stable: false });
    expect(all.slice(1).every((r) => r.stable === true)).toBe(true);
    expect(all.filter((r) => r.origin === "RestApi").map((r) => r.remoteAet)).toEqual([null]);
    expect(all.find((r) => r.summary.studyInstanceUid === STUDY)).toMatchObject({ remoteAet: "CT_EXAMPLE", instanceCount: 4 });
    // 上限を超えたら、新しい上限の数だけと overLimit
    const two = await backend.receivedStudies({ ...day, limit: 2 });
    expect(two.studies).toHaveLength(2);
    expect(two.overLimit).toBe(true);
    // 上限ちょうどは、超えていない
    expect((await backend.receivedStudies({ ...day, limit: 8 })).overLimit).toBe(false);
    // 期間の外（翌日）には無い
    expect((await backend.receivedStudies({ fromMs: day.toMs, toMs: day.toMs + 86_400_000, limit: 1000 })).studies).toEqual([]);
  });

  it("機器の一覧・C-ECHO（offline だけ答えない）・登録の無い機器は 404", async () => {
    const backend = createMockBackend();
    expect((await backend.listModalities()).map((m) => m.id)).toEqual(["dtg", "offline", "workstation"]);
    expect(await backend.echoModality("dtg")).toBe(true);
    expect(await backend.echoModality("offline")).toBe(false);
    await expect(backend.echoModality("nothing")).rejects.toMatchObject({ status: 404 });
  });

  it("送ると、仕事は読むたびに Pending → Running → Success と進む（offline へは Failure）", async () => {
    const backend = createMockBackend();
    const id = (await backend.lookupStudy(STUDY))!;
    expect(id).toBe("3f9ca171-e0dafa89-36c0c97f-c69c8eca-178c4919");
    expect(await backend.lookupStudy("1.2.3")).toBeNull();
    const { jobId } = await backend.sendStudy("dtg", id);
    const states = [];
    for (let i = 0; i < 4; i++) states.push((await backend.jobStatus(jobId))!.state);
    expect(states).toEqual(["Pending", "Running", "Success", "Success"]);
    const failed = (await backend.sendStudy("offline", id)).jobId;
    let last = (await backend.jobStatus(failed))!;
    for (let i = 0; i < 3; i++) last = (await backend.jobStatus(failed))!;
    expect(last).toMatchObject({ state: "Failure", errorCode: 9 });
    await expect(backend.sendStudy("nothing", id)).rejects.toMatchObject({ status: 404 });
    expect(await backend.jobStatus("00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
