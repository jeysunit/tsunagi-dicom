import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpBackend } from "@/lib/backend/http";
import { wadoRsTarget } from "@/lib/backend/relay-path";
import { BackendError } from "@/lib/backend/types";

// 実の画像サーバーの代わりに、手元に自前の CA の証明書で HTTPS のサーバーを立てて確かめる。
// 証明書の確かめを切る道は無いので、BACKEND_CA_FILE（caPem）が無ければつながらないことも見る。

let dir: string;
let server: Server;
let baseUrl: string;
let caPem: string;
const seen: { url: string; authorization?: string; method: string; accept?: string }[] = [];

const studies = JSON.parse(readFileSync("tests/fixtures/orthanc/dicom-web/studies.json", "utf8"));
/** 画像単位の値の見本（合成の UID と患者） */
const instanceDataset = {
  "0020000D": { vr: "UI", Value: ["1.2.3"] },
  "0020000E": { vr: "UI", Value: ["4.5.6"] },
  "00080018": { vr: "UI", Value: ["7.8.9"] },
  "00100020": { vr: "LO", Value: ["JP-TEST-0001"] },
  "00200013": { vr: "IS", Value: [3] },
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "tsunagi-tls-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  run(
    ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=tsunagi test CA"],
    ...["-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"],
    ...["-keyout", "ca.key", "-out", "ca.pem"],
  );
  run("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1", "-keyout", "server.key", "-out", "server.csr");
  writeFileSync(path.join(dir, "server.ext"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\n");
  run(
    ...["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "1"],
    ...["-extfile", "server.ext", "-out", "server.pem"],
  );
  caPem = readFileSync(path.join(dir, "ca.pem"), "utf8");

  server = createServer(
    { key: readFileSync(path.join(dir, "server.key")), cert: readFileSync(path.join(dir, "server.pem")) },
    (req, res) => {
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization, method: req.method ?? "", accept: req.headers.accept });
      if (/\/(thumbnail|rendered)$/.test(req.url ?? "")) {
        // 実の Orthanc の DICOMweb のプラグインと同じく、image/jpeg・image/png の名指し以外の Accept は 400
        const accept = req.headers.accept;
        if (accept === "image/jpeg" || accept === "image/png") {
          res.writeHead(200, { "content-type": accept });
          res.end(Buffer.from([0xff, 0xd8, 0xff]));
        } else {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Unsupported MIME type");
        }
      } else if (req.url?.endsWith("/metadata?gzip=1")) {
        // 圧縮した応答。content-length は圧縮の後の長さ
        const gz = gzipSync(Buffer.from(JSON.stringify(studies)));
        res.writeHead(200, {
          "content-type": "application/dicom+json",
          "content-encoding": "gzip",
          "content-length": String(gz.byteLength),
        });
        res.end(gz);
      } else if (req.url === "/dicom-web/studies/1.2.3/series/4.5.6/instances/7.8.9/metadata") {
        // 画像単位の値（WADO-RS の metadata）：求めた3つの UID の画像を1件返す
        res.writeHead(200, { "content-type": "application/dicom+json" });
        res.end(JSON.stringify([instanceDataset]));
      } else if (/^\/dicom-web\/studies\/1\.2\.3\/series\/4\.5\.6\/instances\/7\.8\.1[123]\/metadata$/.test(req.url ?? "")) {
        // 3つの UID のうち、1つだけが求めたものと違う答え（7.8.11：検査、7.8.12：シリーズ、7.8.13：画像）
        const sop = req.url!.split("/")[7]!;
        const wrong = { vr: "UI", Value: ["9.9.9"] };
        res.writeHead(200, { "content-type": "application/dicom+json" });
        res.end(
          JSON.stringify([
            {
              ...instanceDataset,
              "00080018": sop === "7.8.13" ? wrong : { vr: "UI", Value: [sop] },
              ...(sop === "7.8.11" ? { "0020000D": wrong } : {}),
              ...(sop === "7.8.12" ? { "0020000E": wrong } : {}),
            },
          ]),
        );
      } else if (req.url?.startsWith("/dicom-web/studies/1.2.3/series/4.5.6/instances?")) {
        // 画像の並び：求めた検査・シリーズの行・検査が違う行・シリーズが違う行・UID の無い行
        const row = (study: string | null, series: string | null, sop: string, n: number) => ({
          ...(study ? { "0020000D": { vr: "UI", Value: [study] } } : {}),
          ...(series ? { "0020000E": { vr: "UI", Value: [series] } } : {}),
          "00080018": { vr: "UI", Value: [sop] },
          "00100020": { vr: "LO", Value: ["JP-TEST-0001"] },
          "00200013": { vr: "IS", Value: [n] },
          // スライス位置（DS）。画像サーバーが返したときだけ一覧に添える
          ...(n === 1 ? { "00201041": { vr: "DS", Value: ["12.50"] } } : {}),
        });
        res.writeHead(200, { "content-type": "application/dicom+json" });
        res.end(JSON.stringify([row("1.2.3", "4.5.6", "7.8.9", 1), row("9.9.9", "4.5.6", "7.8.10", 2), row("1.2.3", "9.9.9", "7.8.11", 3), row(null, null, "7.8.12", 4)]));
      } else if (req.url?.startsWith("/dicom-web/studies/1.2.3/series/4.5.6/instances/0.0.0")) {
        res.writeHead(404).end();
      } else if (req.url?.startsWith("/w299/dicom-web/studies?")) {
        // 求めた数より少なく返しても、続きがあることを Warning 299 で知らせる画像サーバー（PS3.18 8.3.4.4.1）
        res.writeHead(200, {
          "content-type": "application/dicom+json",
          warning: "299 orthanc: There are 3 additional results that can be requested",
        });
        res.end(JSON.stringify(studies));
      } else if (req.url?.startsWith("/dicom-web/studies")) {
        res.writeHead(200, { "content-type": "application/dicom+json", "set-cookie": "backend-session=1" });
        res.end(JSON.stringify(studies));
      } else if (req.url === "/statistics") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ CountStudies: 42 }));
      } else {
        res.writeHead(404).end();
      }
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

function backend(extra: { caPem?: string } = {}) {
  return createHttpBackend({
    kind: "orthanc",
    mock: false,
    dicomwebUrl: `${baseUrl}/dicom-web`,
    orthancUrl: baseUrl,
    username: "tsunagi",
    password: "backend-secret",
    ...extra,
  });
}

describe("実の画像サーバーへの接続", () => {
  it("BACKEND_CA_FILE の CA で証明書を確かめてつなぎ、資格情報はサーバーの側で付ける", async () => {
    seen.length = 0;
    const b = backend({ caPem });
    expect(await b.searchStudies()).toMatchObject({ studies: { length: 8 }, complete: true });
    expect(await b.countStudies()).toEqual({ count: 42, exact: true });
    const expected = `Basic ${Buffer.from("tsunagi:backend-secret").toString("base64")}`;
    expect(seen.map((s) => s.authorization)).toEqual([expected, expected]);
    expect(seen[0]!.url).toMatch(/^\/dicom-web\/studies\?limit=1001&includefield=00081030/);
  });

  it("自前の CA を渡さなければ、確かめに失敗してつながらない（確かめを切らない）", async () => {
    await expect(backend().searchStudies()).rejects.toThrow(BackendError);
    await expect(backend().searchStudies()).rejects.toThrow("画像サーバーに接続できません");
  });

  it("検索の件数を上限の 1000 に収め、続きがあるかを知るために 1 件多く求める", async () => {
    seen.length = 0;
    await backend({ caPem }).searchStudies(50_000);
    expect(seen[0]!.url).toMatch(/^\/dicom-web\/studies\?limit=1001&/);
  });

  it("答えに Warning 299 があれば、返した数が上限より少なくても「全部」としない（検査日の範囲で区切って問い合わせ直す）", async () => {
    seen.length = 0;
    const b = createHttpBackend({ kind: "orthanc", mock: false, dicomwebUrl: `${baseUrl}/w299/dicom-web`, orthancUrl: baseUrl, caPem });
    const r = await b.searchStudies();
    expect(r.complete).toBe(false);
    const asked = seen.filter((s) => s.url.startsWith("/w299/dicom-web/studies?"));
    expect(asked.length).toBeGreaterThan(1);
    // 2 回目からは検査日の範囲の条件が付く
    expect(new URL(asked[1]!.url, "https://x").searchParams.get("StudyDate")).toMatch(/^\d{8}-$|^\d{8}-\d{8}$|^-\d{8}$|^\d{8}$/);
  });

  const metadata = wadoRsTarget(["studies", "1.2.3", "series", "1.2.3.4", "metadata"])!;

  it("中継の応答に、画像サーバーの cookie などのヘッダーを渡さない", async () => {
    const res = await backend({ caPem }).relayDicomweb({
      method: "GET",
      target: metadata,
      search: "",
      accept: "application/dicom+json",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/dicom+json");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen.at(-1)!.url).toBe("/dicom-web/studies/1.2.3/series/1.2.3.4/metadata");
    expect(seen.at(-1)!.method).toBe("GET");
  });

  describe("中継の Accept", () => {
    // ブラウザの <img> の Accept（Chrome）と、png を名指しする Safari の形
    const IMG_ACCEPT = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";
    const SAFARI_ACCEPT = "image/png,image/svg+xml,image/*;q=0.8,video/*;q=0.8,*/*;q=0.5";
    const relay = (rest: string[], accept?: string | null) =>
      backend({ caPem }).relayDicomweb({
        method: "GET",
        target: wadoRsTarget(["studies", "1.2.3", "series", "1.2.3.4", ...rest])!,
        search: "",
        accept,
      });

    it("サムネイルの道では、ブラウザの <img> の Accept を渡さず image/jpeg にする（400 にならない）", async () => {
      const res = await relay(["thumbnail"], IMG_ACCEPT);
      expect(res.status).toBe(200);
      expect(seen.at(-1)!.accept).toBe("image/jpeg");
      expect(res.headers.get("content-type")).toBe("image/jpeg");
    });

    it("Accept が無くても image/jpeg。rendered も同じ", async () => {
      expect((await relay(["thumbnail"])).status).toBe(200);
      expect(seen.at(-1)!.accept).toBe("image/jpeg");
      expect((await relay(["instances", "1.2.3.5", "rendered"], "*/*")).status).toBe(200);
      expect(seen.at(-1)!.accept).toBe("image/jpeg");
    });

    it("image/png を名指しし、image/jpeg を名指ししていないときだけ image/png", async () => {
      expect((await relay(["thumbnail"], SAFARI_ACCEPT)).status).toBe(200);
      expect(seen.at(-1)!.accept).toBe("image/png");
      await relay(["thumbnail"], "image/png, image/jpeg");
      expect(seen.at(-1)!.accept).toBe("image/jpeg");
      await relay(["thumbnail"], "image/png;q=0, */*");
      expect(seen.at(-1)!.accept).toBe("image/jpeg");
    });

    it("ビューアの取得（metadata・frames など）は、ブラウザの Accept をそのまま渡す", async () => {
      await relay(["metadata"], "application/dicom+json");
      expect(seen.at(-1)!.accept).toBe("application/dicom+json");
      const multipart = 'multipart/related; type="application/octet-stream"; transfer-syntax=*';
      await relay(["instances", "1.2.3.5", "frames", "1"], multipart);
      expect(seen.at(-1)!.accept).toBe(multipart);
      await relay(["metadata"], IMG_ACCEPT);
      expect(seen.at(-1)!.accept).toBe(IMG_ACCEPT);
    });

    it("query の accept は画像サーバーへ渡さない（受け取る型は Accept のヘッダーで求める。PS3.18 8.3.3.1）", async () => {
      await backend({ caPem }).relayDicomweb({
        method: "GET",
        target: wadoRsTarget(["studies", "1.2.3", "series", "1.2.3.4", "thumbnail"])!,
        search: "?accept=image/gif&viewport=64,64",
        accept: "image/png",
      });
      expect(seen.at(-1)!.url).toBe("/dicom-web/studies/1.2.3/series/1.2.3.4/thumbnail?viewport=64,64");
      expect(seen.at(-1)!.accept).toBe("image/png");
    });
  });

  it("圧縮の応答をほどいて渡し、画像サーバーの content-length・content-encoding を通さない", async () => {
    const res = await backend({ caPem }).relayDicomweb({ method: "GET", target: metadata, search: "?gzip=1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    // 長さの食い違いがあれば、ここで読み切れずに失敗する
    expect(await res.json()).toHaveLength(8);
  });

  it("中継は WADO-RS の読み取りだけ（確かめを通っていない宛先・書き込みの method・長すぎる query を断る）", async () => {
    seen.length = 0;
    const b = backend({ caPem });
    await expect(
      b.relayDicomweb({ method: "GET", target: { path: "studies", studyInstanceUid: "" }, search: "" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(b.relayDicomweb({ method: "POST" as "GET", target: metadata, search: "" })).rejects.toMatchObject({
      status: 405,
    });
    await expect(
      b.relayDicomweb({ method: "GET", target: metadata, search: `?${"x".repeat(3000)}` }),
    ).rejects.toMatchObject({ status: 400 });
    // どれも画像サーバーへは届いていない
    expect(seen).toHaveLength(0);
  });

  it("段 2：検査日の範囲は QIDO-RS の StudyDate で求め、答えの範囲の外の検査は捨てる", async () => {
    seen.length = 0;
    const studiesInRange = await backend({ caPem }).searchStudies(1000, { dateFrom: "20261017", dateTo: "20261017" });
    expect(new URL(seen[0]!.url, "https://x").searchParams.get("StudyDate")).toBe("20261017");
    // 手元のサーバーは範囲を見ずに 8 件を返すので、BFF の側で 4 件に絞る
    expect(studiesInRange.studies).toHaveLength(4);
  });

  it("詳細条件は QIDO-RS の条件で求め（文字は `*語*`）、答えの条件に合わない検査は捨てる", async () => {
    seen.length = 0;
    const found = await backend({ caPem }).searchStudies(1000, {
      patientBirthDate: "19750510",
      patientSex: "M",
      accessionNumber: "ACC-0001",
    });
    const params = new URL(seen[0]!.url, "https://x").searchParams;
    expect(params.get("PatientBirthDate")).toBe("19750510");
    expect(params.get("PatientSex")).toBe("M");
    expect(params.get("AccessionNumber")).toBe("*ACC-0001*");
    expect(params.has("StudyDescription")).toBe(false);
    expect(params.has("ReferringPhysicianName")).toBe(false);
    // 手元のサーバーは条件を見ずに 8 件を返すので、BFF の側で JP-TEST-0001 の 2 件に絞る
    expect(found.studies.map((s) => s.accessionNumber).sort()).toEqual(["ACC-0001-1", "ACC-0001-2"]);
  });

  it("段 2：シリーズと値の全部は、UID を確かめてから QIDO-RS で求める", async () => {
    seen.length = 0;
    const b = backend({ caPem });
    await b.searchSeries("1.2.3");
    expect(seen.at(-1)!.url).toMatch(/^\/dicom-web\/studies\/1\.2\.3\/series\?includefield=0008103E/);
    const ds = await b.studyDataset("1.2.826.0.1.3680043.8.498.37441995708659611703386240683600654012");
    const url = new URL(seen.at(-1)!.url, "https://x");
    expect(url.pathname).toBe("/dicom-web/studies");
    expect(url.searchParams.get("includefield")).toBe("all");
    expect(ds).not.toBeNull();
    const before = seen.length;
    await expect(b.searchSeries("../../system")).rejects.toMatchObject({ status: 400 });
    await expect(b.studyDataset("1.2.3&PatientID=*")).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(before);
  });

  it("画像単位の DICOM タグ：画像の並びは QIDO-RS、値は WADO-RS の metadata。UID を確かめ、答えの UID が違えば返さない", async () => {
    seen.length = 0;
    const b = backend({ caPem });
    const found = await b.searchInstances("1.2.3", "4.5.6");
    const list = new URL(seen.at(-1)!.url, "https://x");
    expect(list.pathname).toBe("/dicom-web/studies/1.2.3/series/4.5.6/instances");
    expect(list.searchParams.getAll("includefield")).toEqual(["00200013", "00280008", "00201041", "00100020"]);
    // 答えの検査・シリーズの UID が求めたものと違う行・UID の無い行は返さない
    expect(found.map((i) => i.sopInstanceUid)).toEqual(["7.8.9"]);
    expect(found[0]).toMatchObject({ patientId: "JP-TEST-0001", instanceNumber: "1", sliceLocation: 12.5 });

    const ds = await b.instanceDataset("1.2.3", "4.5.6", "7.8.9");
    expect(seen.at(-1)).toMatchObject({ url: "/dicom-web/studies/1.2.3/series/4.5.6/instances/7.8.9/metadata", method: "GET", accept: "application/dicom+json" });
    expect(ds).toEqual(instanceDataset);
    // 見つからなければ null
    expect(await b.instanceDataset("1.2.3", "4.5.6", "0.0.0")).toBeNull();
    // 答えの UID が求めたものと違うときは返さない（検査・シリーズ・画像の UID を1つずつ違えて見る）
    for (const sop of ["7.8.11", "7.8.12", "7.8.13"]) expect(await b.instanceDataset("1.2.3", "4.5.6", sop), sop).toBeNull();
    // 画像の値でない答え（手元のサーバーは検査の検索の答えを返す）も返さない
    expect(await b.instanceDataset("1.2.3", "4.5.6", "1.1.1")).toBeNull();
    // UID の形でないものは、画像サーバーへ求めずに断る
    const before = seen.length;
    await expect(b.searchInstances("1.2.3", "../x")).rejects.toMatchObject({ status: 400 });
    await expect(b.instanceDataset("1.2.3", "4.5.6", "7.8.9/../../x")).rejects.toMatchObject({ status: 400 });
    expect(seen).toHaveLength(before);
  });
});
