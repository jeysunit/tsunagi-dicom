import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// tests/fixtures/orthanc/README.md の「置き換えの規則」と「置き換えた後の確かめ」を、試験でも見る。
const root = path.resolve("tests/fixtures/orthanc");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const jsonFiles = files(root).filter((f) => f.endsWith(".json"));
const texts = jsonFiles.map((f) => ({ file: path.relative(root, f), text: readFileSync(f, "utf8") }));

function matches(re: RegExp) {
  return texts.flatMap(({ file, text }) => [...text.matchAll(re)].map((m) => `${file}: ${m[0]}`));
}

describe("見本の置き換えの規則", () => {
  it("URL は例の名前（pacs.example.org）だけ", () => {
    expect(matches(/https?:\/\/(?!pacs\.example\.org)[^"/ ]+/g)).toEqual([]);
  });

  it("JSON の値の頭に私用の IPv4 の住所が無い", () => {
    expect(matches(/"(192\.168|172\.(1[6-9]|2[0-9]|3[01])|10)\.[0-9]+\.[0-9]+(\.[0-9]+)?/g)).toEqual([]);
  });

  it("秘密らしい語が無い", () => {
    expect(matches(/password|passwd|token|secret|apikey|api_key/gi)).toEqual([]);
  });

  it("患者は合成の JP-TEST- だけ", () => {
    const ids = matches(/"PatientID": "([^"]*)"/g).map((m) => m.split(": ").slice(1).join(": "));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id).toMatch(/^"PatientID": "JP-TEST-/);
  });

  it("規則 2：/system の施設を示しうる値は例の値", () => {
    const system = JSON.parse(readFileSync(path.join(root, "rest/system.json"), "utf8"));
    expect(system).toMatchObject({
      Name: "Orthanc",
      DicomAet: "ORTHANC",
      DatabaseServerIdentifier: "00000000-00000000-00000000-00000000-00000000",
      UserMetadata: {},
    });
  });

  it("規則 7：/system の版の値は例の値（写した元の版を出さない）", () => {
    const system = JSON.parse(readFileSync(path.join(root, "rest/system.json"), "utf8"));
    expect(system.Version).toBe("1.0.0");
    expect(Object.keys(system.ThirdPartyVersions).length).toBeGreaterThan(0);
    expect(new Set(Object.values(system.ThirdPartyVersions))).toEqual(new Set(["0.0.0"]));
    expect(system.ThirdPartyPatches).toEqual([]);
  });
});
