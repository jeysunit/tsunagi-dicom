import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { datasetRows, instanceTagRows, VALUE_MAX_CHARS } from "@/lib/all-values";
import type { DicomJsonDataset } from "@/lib/backend/dicom-json";
import { DEFAULT_INSTANCE_TAGS, displayTag, tagName, TAG_NAMES } from "@/lib/instance-tags";

// 画像ごとの「主なタグ」（docs/spec.md の 3.1）：設定のタグの選び出し・値の出し方・長い値の切り方・タグ名

const DS: DicomJsonDataset = {
  "00080018": { vr: "UI", Value: ["1.2.3.4"] },
  "00200013": { vr: "IS", Value: ["2"] },
  "00280010": { vr: "US", Value: [512] },
  "00280030": { vr: "DS", Value: [0.5, 0.5] },
  "00100010": { vr: "PN", Value: [{ Alphabetic: "Shiken^Hanako", Ideographic: "試験^花子", Phonetic: "しけん^はなこ" }] },
  "00204000": { vr: "LT", Value: ["<b>x</b>"] },
  "00082112": { vr: "SQ", Value: [{}, {}] },
  "7FE00010": { vr: "OW", BulkDataURI: "https://pacs.example.org/bulk/1" },
  "00291010": { vr: "OB", InlineBinary: "AAAA" },
};

describe("設定のタグの選び出し", () => {
  it("設定のタグだけを、設定の順に返す。設定に無いタグは返さない", () => {
    const rows = instanceTagRows(DS, ["00280010", "00080018", "00200013"]);
    expect(rows.map((r) => r.tag)).toEqual(["0028,0010", "0008,0018", "0020,0013"]);
    expect(rows.map((r) => r.value)).toEqual(["512", "1.2.3.4", "2"]);
    expect(rows.some((r) => r.tag === "0010,0010")).toBe(false);
  });

  it("画像に無いタグも行を返し、VR は空・値は null", () => {
    expect(instanceTagRows(DS, ["00180050"])).toEqual([{ tag: "0018,0050", name: "スライス厚", vr: "", value: null }]);
  });

  it("複数の値は \\ でつなぎ、人の名前は Alphabetic=Ideographic=Phonetic の形", () => {
    const [spacing, name] = instanceTagRows(DS, ["00280030", "00100010"]);
    expect(spacing!.value).toBe("0.5\\0.5");
    expect(name!.value).toBe("Shiken^Hanako=試験^花子=しけん^はなこ");
  });

  it("HTML の形の値は、文字のまま返す", () => {
    expect(instanceTagRows(DS, ["00204000"])[0]!.value).toBe("<b>x</b>");
  });

  it("バイナリ（BulkDataURI・InlineBinary・バイナリの VR）は「（バイナリ）」。シーケンスは件数", () => {
    const binary = (vr: string): DicomJsonDataset => ({ "00091001": { vr, Value: ["x"] } });
    expect(instanceTagRows(DS, ["7FE00010", "00291010"]).map((r) => r.value)).toEqual(["（バイナリ）", "（バイナリ）"]);
    for (const vr of ["OB", "OD", "OF", "OL", "OV", "OW", "UN"]) expect(instanceTagRows(binary(vr), ["00091001"])[0]!.value).toBe("（バイナリ）");
    expect(instanceTagRows(DS, ["00082112"])[0]!.value).toBe("（シーケンス 2 件）");
  });

  it("1024 文字を超える値は、先頭の 1024 文字と全体の文字数を返す。1024 文字ちょうどは切らない", () => {
    const long: DicomJsonDataset = { "00204000": { vr: "LT", Value: ["あ".repeat(5000)] } };
    const [row] = instanceTagRows(long, ["00204000"]);
    expect(Array.from(row!.value!)).toHaveLength(VALUE_MAX_CHARS);
    expect(row!.length).toBe(5000);
    const exact: DicomJsonDataset = { "00204000": { vr: "LT", Value: ["a".repeat(1024)] } };
    expect(instanceTagRows(exact, ["00204000"])[0]).not.toHaveProperty("length");
  });

  it("文字数は符号位置で数え、サロゲートの組（絵文字）を割らない", () => {
    const emoji: DicomJsonDataset = { "00204000": { vr: "LT", Value: ["a" + "😀".repeat(2000)] } };
    const [row] = instanceTagRows(emoji, ["00204000"]);
    expect(row!.length).toBe(2001);
    expect(row!.value!.endsWith("😀")).toBe(true);
    expect(row!.value!.isWellFormed()).toBe(true);
  });

  it("小文字のキーの答えでも、タグを見つける", () => {
    expect(instanceTagRows({ "0008103e": { vr: "LO", Value: ["頭部"] } }, ["0008103E"])[0]!.value).toBe("頭部");
  });

  it("すべての値の行（datasetRows）も、バイナリの VR は中身を出さず、長い値は切って全体の文字数を添える", () => {
    expect(datasetRows({ "00091001": { vr: "UN", Value: ["x"] } })).toEqual([{ tag: "0009,1001", vr: "UN", value: "（バイナリ）" }]);
    const [row] = datasetRows({ "00204000": { vr: "LT", Value: ["い".repeat(3000)] } });
    expect(row).toEqual({ tag: "0020,4000", vr: "LT", value: "い".repeat(VALUE_MAX_CHARS), length: 3000 });
  });
});

describe("日本語の値（ISO 2022 IR 87。Orthanc の WADO-RS の metadata の写し）", () => {
  it("Orthanc が Unicode に直した氏名と検査名を、読み替えずにそのまま返す", () => {
    const [ds] = JSON.parse(readFileSync(path.resolve("tests/fixtures/orthanc/dicom-web/iso2022-instance-metadata.json"), "utf8")) as DicomJsonDataset[];
    const rows = instanceTagRows(ds!, ["00080005", "00100010", "00081030"]);
    expect(rows.map((r) => [r.name, r.value])).toEqual([
      ["特定文字集合", "ISO 2022 IR 87"],
      ["氏名", "ITEST^HANAKO=試験^花子=しけん^はなこ"],
      ["検査名", "頭部単純"],
    ]);
  });
});

describe("タグ名", () => {
  it("既定の 25 のタグは、すべて日本語のタグ名を持つ", () => {
    for (const tag of DEFAULT_INSTANCE_TAGS) expect(tagName(tag), displayTag(tag)).toMatch(/[ぁ-んァ-ヶ一-龠]/);
  });

  it("画面の用語集の言葉をそのまま使う（画像番号・検査名・シリーズ名・氏名・患者ID・受付番号・生年月日・性別・モダリティ）", () => {
    expect(tagName("00200013")).toBe("画像番号");
    expect(tagName("00081030")).toBe("検査名");
    expect(tagName("0008103E")).toBe("シリーズ名");
    expect(tagName("00100010")).toBe("氏名");
    expect(tagName("00100020")).toBe("患者ID");
    expect(tagName("00080050")).toBe("受付番号");
    expect(tagName("00100030")).toBe("生年月日");
    expect(tagName("00100040")).toBe("性別");
    expect(tagName("00080060")).toBe("モダリティ");
    expect(tagName("00080090")).toBe("紹介医");
  });

  it("表に無いタグ（私的タグを含む）は空。`0008,0018` の形でも引ける", () => {
    expect(tagName("00291010")).toBe("");
    expect(tagName("0008,0018")).toBe("SOPインスタンスUID");
    // 表のキーはすべて 8 桁の大文字の 16 進
    for (const key of Object.keys(TAG_NAMES)) expect(key).toMatch(/^[0-9A-F]{8}$/);
  });
});
