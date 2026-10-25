import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createViewerProxy, forwardHeaders, isReadMethod } from "../../docker/dev/viewer-proxy/proxy";

// 開発の一式のビューアの入口（docker/dev/viewer-proxy）：GET と HEAD だけを Orthanc に通す。

const servers: Server[] = [];
const listen = async (server: Server) => {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
};
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve());
          s.closeAllConnections();
        }),
    ),
  );
});

interface Seen {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
}

async function setup() {
  const seen: Seen[] = [];
  const upstream = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain", "x-from": "orthanc" });
    res.end("ok");
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await listen(createViewerProxy({ upstream: `http://127.0.0.1:${upstreamPort}`, timeoutMs: 2000 }));
  return { seen, proxyPort };
}

const send = (port: number, method: string, path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(method === "GET" || method === "HEAD" ? undefined : "x");
  });

describe("読み取りの方法", () => {
  it("GET と HEAD だけ", () => {
    expect(["GET", "get", "HEAD"].every(isReadMethod)).toBe(true);
    expect(["POST", "PUT", "DELETE", "PATCH", "OPTIONS", "", undefined].some(isReadMethod)).toBe(false);
  });
});

describe("上流へ渡すヘッダー", () => {
  it("接続ごとのヘッダーは落とし、Authorization と Host は残す", () => {
    const out = forwardHeaders({ host: "127.0.0.1:18042", authorization: "Basic abc", connection: "keep-alive", "transfer-encoding": "chunked" });
    expect(out).toEqual({ host: "127.0.0.1:18042", authorization: "Basic abc" });
  });
});

describe("入口", () => {
  it("GET は Orthanc に通し、パスと Authorization をそのまま渡す。応答のヘッダーも返す", async () => {
    const { seen, proxyPort } = await setup();
    const res = await send(proxyPort, "GET", "/ohif/viewer?StudyInstanceUIDs=1.2.3", { authorization: "Basic abc" });
    expect(res).toMatchObject({ status: 200, body: "ok" });
    expect(res.headers["x-from"]).toBe("orthanc");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/ohif/viewer?StudyInstanceUIDs=1.2.3" });
    expect(seen[0]!.headers.authorization).toBe("Basic abc");
  });

  it("書き込みの方法は 405 で断り、Orthanc には届かない", async () => {
    const { seen, proxyPort } = await setup();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await send(proxyPort, method, "/instances", { authorization: "Basic abc" });
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD");
    }
    expect(seen).toHaveLength(0);
  });

  it("Orthanc につながらなければ 502", async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const proxyPort = await listen(createViewerProxy({ upstream: `http://127.0.0.1:${port}`, timeoutMs: 500 }));
    expect((await send(proxyPort, "GET", "/system")).status).toBe(502);
  });
});
