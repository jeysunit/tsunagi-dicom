import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpBackend } from "@/lib/backend/http";
import { BackendError } from "@/lib/backend/types";

// 実の画像サーバーの代わりに、手元に自前の CA の証明書で HTTPS のサーバーを立てて確かめる。
// 証明書の確かめを切る道は無いので、BACKEND_CA_FILE（caPem）が無ければつながらないことも見る。

let dir: string;
let server: Server;
let baseUrl: string;
let caPem: string;
const seen: { url: string; authorization?: string; method: string }[] = [];

const studies = JSON.parse(readFileSync("tests/fixtures/orthanc/dicom-web/studies.json", "utf8"));

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
      seen.push({ url: req.url ?? "", authorization: req.headers.authorization, method: req.method ?? "" });
      if (req.url?.startsWith("/dicom-web/studies")) {
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
    expect(await b.searchStudies()).toHaveLength(8);
    expect(await b.countStudies()).toEqual({ count: 42, exact: true });
    const expected = `Basic ${Buffer.from("tsunagi:backend-secret").toString("base64")}`;
    expect(seen.map((s) => s.authorization)).toEqual([expected, expected]);
    expect(seen[0]!.url).toMatch(/^\/dicom-web\/studies\?limit=1000&includefield=00081030/);
  });

  it("自前の CA を渡さなければ、確かめに失敗してつながらない（確かめを切らない）", async () => {
    await expect(backend().searchStudies()).rejects.toThrow(BackendError);
    await expect(backend().searchStudies()).rejects.toThrow("画像サーバーにつながらない");
  });

  it("中継の応答に、画像サーバーの cookie などのヘッダーを渡さない", async () => {
    const res = await backend({ caPem }).relayDicomweb({
      method: "GET",
      segments: ["studies"],
      search: "?PatientID=JP-TEST-0001",
      accept: "application/dicom+json",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/dicom+json");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(seen.at(-1)!.url).toBe("/dicom-web/studies?PatientID=JP-TEST-0001");
  });
});
