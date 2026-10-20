import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { ITEST } from "./env";

// BFF と Orthanc の REST の間に置く入口（リバースプロキシの代わり）。docs/round-trip-test.md の 7
// 「受けた後に答えが失われたとき」を作るために、送る要求（POST /modalities/{id}/store）だけ、
// Orthanc へ渡して答えを最後まで受けてから、BFF には 504 を返す（入口が答えを待ちきれなかった形）。
// ほかの要求はそのまま渡す。待ち受けは手元（127.0.0.1）だけ。試験の worker の中で動かす。

export type GateMode = "pass" | "drop-store-response";

const STORE_PATH = /^\/modalities\/[^/]+\/store$/;

export interface Gate {
  setMode(mode: GateMode): void;
  /** drop-store-response で、Orthanc が答えたのに BFF へ渡さなかった送る要求の、Orthanc の答え（状態と本文） */
  dropped: { status: number; body: string }[];
  close(): Promise<void>;
}

function readAll(stream: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export async function startGate(): Promise<Gate> {
  let mode: GateMode = "pass";
  const dropped: Gate["dropped"] = [];

  const server: Server = createServer((req, res) => {
    const pathOnly = (req.url ?? "/").split("?")[0] ?? "/";
    const drop = mode === "drop-store-response" && req.method === "POST" && STORE_PATH.test(pathOnly);
    const upstream = request(
      { host: "127.0.0.1", port: ITEST.orthancPort, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        if (!drop) {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          return;
        }
        // Orthanc は受けて答えた。その答えを BFF へは渡さず、入口の時間切れ（504）にする
        void readAll(up).then((body) => {
          dropped.push({ status: up.statusCode ?? 0, body: body.toString("utf8") });
          res.writeHead(504, { "content-type": "text/plain" });
          res.end("Gateway Timeout (itest gate)");
        });
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
      res.end("Bad Gateway (itest gate)");
    });
    req.pipe(upstream);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(ITEST.gatePort, "127.0.0.1", () => resolve());
  });

  return {
    setMode(next) {
      mode = next;
    },
    dropped,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        // BFF（undici）は接続を使い回すので、残った接続も閉じる
        server.closeAllConnections();
      }),
  };
}
