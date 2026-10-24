import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROLES, type Role } from "@/lib/auth/roles";
import { createHttpBackend } from "@/lib/backend/http";
import { createMockBackend } from "@/lib/backend/mock";
import type { Backend } from "@/lib/backend/types";
import {
  allowlistFor,
  pickFields,
  ROLE_FIELD_ALLOWLIST,
  STUDY_FIELDS,
  studyView,
  type FieldAllowlistMap,
} from "@/lib/fields";
import { listStudies } from "@/lib/study-list";

// 役割ごとの許可の一覧（docs/spec.md 原則 8）。
// モック（Orthanc・DICOMweb）と、実の画像サーバーの形（Orthanc・DICOMweb。手元の HTTP のサーバーで代える）のどれでも、
// 許可の一覧に無い項目が画面の API（src/lib/study-list.ts）から返らないことを確かめる。

const studies = JSON.parse(readFileSync("tests/fixtures/orthanc/dicom-web/studies.json", "utf8")) as Record<
  string,
  unknown
>[];

/** 画像サーバーが返しうる、画面に出さない値（施設・住所・別の ID・職業・取得の URL など）。どれも画面の API に出ない */
const EXTRA_TAGS: Record<string, { vr: string; Value: unknown[] }> = {
  "00080080": { vr: "LO", Value: ["EXTRA-INSTITUTION-must-not-leak"] },
  "00101040": { vr: "LO", Value: ["EXTRA-ADDRESS-must-not-leak"] },
  "00101000": { vr: "LO", Value: ["EXTRA-OTHER-ID-must-not-leak"] },
  "00102180": { vr: "SH", Value: ["EXTRA-OCCUPATION-must-not-leak"] },
  "00081190": { vr: "UR", Value: ["https://pacs.example.org/EXTRA-RETRIEVE-URL-must-not-leak"] },
};
const EXTRA_MARK = "must-not-leak";
const withExtras = studies.map((s) => ({ ...s, ...EXTRA_TAGS }));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url?.startsWith("/dicom-web/studies")) {
      res.writeHead(200, { "content-type": "application/dicom+json" });
      res.end(JSON.stringify(withExtras));
    } else if (req.url === "/statistics") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ CountStudies: 8 }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** 試験の対象の画像サーバー。手元のサーバーの住所は起動の後に決まるので、使う時に作る */
const BACKENDS: [string, () => Backend][] = [
  ["モック（Orthanc の形）", () => createMockBackend()],
  ["Orthanc", () => createHttpBackend({ kind: "orthanc", mock: false, dicomwebUrl: `${baseUrl}/dicom-web`, orthancUrl: baseUrl })],
];

/**
 * 一般の役割だけ、許可の一覧を狭めた割り当て（2026-10-20 に役割を管理者と一般の2つにしたので、前の「閲覧」を狭める形を
 * 「一般」を狭める形に、前の「医師」で見ていた「ほかの役割の見え方は変わらない」を「管理者」で見る形にした。確かめる中身は同じ）
 */
const NARROW: FieldAllowlistMap = {
  ...ROLE_FIELD_ALLOWLIST,
  general: { study: ["studyInstanceUid", "modalities", "studyDate"], series: ["seriesInstanceUid"] },
};

describe("画面の API は、許可の一覧の項目だけを返す（モック・Orthanc）", () => {
  for (const [label, make] of BACKENDS) {
    describe(label, () => {
      it.each(ROLES)("既定の役割 %s：一覧の項目だけで、画面に出さない値は返らない", async (role) => {
        const { studies: views } = await listStudies({ backend: make(), role, actorId: "t" });
        expect(views).toHaveLength(8);
        for (const view of views) {
          expect(Object.keys(view).every((k) => (STUDY_FIELDS as readonly string[]).includes(k))).toBe(true);
          // 既定の役割は、一覧の画面に要る項目をすべて見る（見え方を変えない）
          expect(Object.keys(view).sort()).toEqual([...STUDY_FIELDS].sort());
        }
        expect(JSON.stringify(views)).not.toContain(EXTRA_MARK);
        expect(JSON.stringify(views)).not.toContain("pacs.example.org");
      });

      it("許可の一覧を狭めた役割には、載っていない項目が返らない", async () => {
        const { studies: views } = await listStudies({ backend: make(), role: "general", actorId: "t", allowlists: NARROW });
        expect(views).toHaveLength(8);
        for (const view of views) expect(Object.keys(view).sort()).toEqual(["modalities", "studyDate", "studyInstanceUid"]);
        const text = JSON.stringify(views);
        for (const leaked of ["JP-TEST-", "山田", "やまだ", "Yamada", "19750510", "ACC-"]) expect(text).not.toContain(leaked);
        // ほかの役割の見え方は変わらない
        const other = await listStudies({ backend: make(), role: "admin", actorId: "t", allowlists: NARROW });
        expect(JSON.stringify(other.studies)).toContain("JP-TEST-");
      });

      it("検査日を許されていない役割には、検査日の絞り込みも効かない（隠した項目で探せない）", async () => {
        const map: FieldAllowlistMap = { ...ROLE_FIELD_ALLOWLIST, general: { study: ["studyInstanceUid"], series: [] } };
        const filter = { date: "range" as const, from: "2026-10-17", to: "2026-10-17" };
        expect((await listStudies({ backend: make(), role: "general", actorId: "t", allowlists: map }, filter)).studies).toHaveLength(8);
        expect((await listStudies({ backend: make(), role: "admin", actorId: "t", allowlists: map }, filter)).studies).toHaveLength(4);
      });

      it("割り当ての無い役割には、何も返さない（出ない側に倒れる）", async () => {
        const map = { ...ROLE_FIELD_ALLOWLIST } as Partial<FieldAllowlistMap>;
        delete map.general;
        const { studies: views } = await listStudies({ backend: make(), role: "general", actorId: "t", allowlists: map as FieldAllowlistMap });
        expect(views.every((v) => Object.keys(v).length === 0)).toBe(true);
      });
    });
  }
});

describe("許可の一覧の部品", () => {
  it("氏名は漢字・かな・ローマ字に分けて返し、PN の元の文字列は返さない", () => {
    const view = studyView(
      {
        studyInstanceUid: "1.2.3",
        patientId: "JP-TEST-0001",
        patientName: "Yamada^Taro=山田^太郎=やまだ^たろう",
        patientBirthDate: "19750510",
        patientSex: "M",
        studyDate: "20261017",
        studyTime: "093000",
        accessionNumber: "ACC-1",
        studyDescription: "",
        studyId: "1",
        referringPhysicianName: "Shiken^Ishi=試験^医師=しけん^いし",
        modalities: ["CT"],
        seriesCount: 1,
        instanceCount: 4,
      },
      allowlistFor("general"),
    );
    expect(view.patientName).toBe("山田 太郎");
    expect(view.patientKana).toBe("やまだ たろう");
    expect(view.patientNameAlphabetic).toBe("Yamada Taro");
    expect(view.referringPhysicianName).toBe("試験 医師");
    expect(JSON.stringify(view)).not.toContain("^");
  });

  it("元の物にある、一覧に無い項目は写さない", () => {
    const record = { a: 1, b: 2, secret: "x" } as Record<string, unknown>;
    expect(pickFields(record, ["a", "b"], ["a"])).toEqual({ a: 1 });
    expect(pickFields(record, ["a", "b"], ["a", "secret"])).toEqual({ a: 1 });
  });

  it("一覧に無い役割の名前（prototype の名前を含む）は空", () => {
    for (const role of ["__proto__", "constructor", "blind"] as unknown as Role[]) {
      expect(allowlistFor(role)).toEqual({ study: [], series: [] });
    }
  });
});
