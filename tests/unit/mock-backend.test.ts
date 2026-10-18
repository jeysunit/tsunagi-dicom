import { describe, expect, it } from "vitest";
import { personNameToString } from "@/lib/backend/dicom-json";
import { createMockBackend } from "@/lib/backend/mock";
import { safeRelayPath } from "@/lib/backend/relay-path";
import { BackendError } from "@/lib/backend/types";

describe("モックのバックエンド", () => {
  for (const kind of ["orthanc", "dicomweb"] as const) {
    it(`${kind}：見本の 8 件の検査を新しい順に返し、件数も 8`, async () => {
      const backend = createMockBackend(kind);
      const studies = await backend.searchStudies();
      expect(studies).toHaveLength(8);
      expect(await backend.countStudies()).toEqual({ count: 8, exact: true });
      const keys = studies.map((s) => s.studyDate + s.studyTime);
      expect(keys).toEqual([...keys].sort().reverse());
      expect(studies.every((s) => s.patientId.startsWith("JP-TEST-"))).toBe(true);
    });
  }

  it("DICOM JSON の値を検査の形にする", async () => {
    const studies = await createMockBackend("dicomweb").searchStudies();
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

  it("中継：QIDO-RS の検査と、見本のある検査のシリーズを返す", async () => {
    const backend = createMockBackend("orthanc");
    const studies = await backend.relayDicomweb({ method: "GET", segments: ["studies"], search: "" });
    expect(studies.status).toBe(200);
    expect(studies.headers.get("content-type")).toBe("application/dicom+json");
    expect(await studies.json()).toHaveLength(8);

    const uid = "1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012";
    const series = await backend.relayDicomweb({ method: "GET", segments: ["studies", uid, "series"], search: "" });
    expect(series.status).toBe(200);

    const missing = await backend.relayDicomweb({ method: "GET", segments: ["studies", "1.2.3", "series"], search: "" });
    expect(missing.status).toBe(404);
  });

  it("中継：モックは書き込みを受けない", async () => {
    const res = await createMockBackend("orthanc").relayDicomweb({ method: "POST", segments: ["studies"], search: "" });
    expect(res.status).toBe(501);
  });

  it("中継：見本の外のファイルへ出る path を断る", async () => {
    const backend = createMockBackend("orthanc");
    for (const segments of [["..", "rest", "system.json"], ["studies", ".."], ["studies%2F.."], []]) {
      await expect(backend.relayDicomweb({ method: "GET", segments, search: "" })).rejects.toBeInstanceOf(BackendError);
    }
  });
});

describe("中継の path", () => {
  it("使える字だけを通す", () => {
    expect(safeRelayPath(["studies", "1.2.3", "series"])).toBe("studies/1.2.3/series");
    expect(() => safeRelayPath(["studies", "a/b"])).toThrow(BackendError);
    expect(() => safeRelayPath(["studies", "a b"])).toThrow(BackendError);
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
