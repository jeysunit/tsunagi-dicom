import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { ITEST } from "./env";

// BFF と Orthanc の REST の間に置く入口（リバースプロキシの代わり）。docs/round-trip-test.md の 7
// 「受けた後に答えが失われたとき」を作るために、送る要求（POST /modalities/{id}/store）だけ、
// Orthanc へ渡して答えを最後まで受けてから、BFF には 504 を返す（入口が答えを待ちきれなかった形）。
// HL7 の書き換えの最中に画像を届けるために、書き換えの要求（POST /studies/{id}/modify）の答えを、試験の処理の後まで
// BFF へ渡さずに持つこともできる（onceAfterModify）。
// ほかの要求はそのまま渡す。待ち受けは手元（127.0.0.1）だけ。試験の worker の中で動かす。

export type GateMode = "pass" | "drop-store-response";

const STORE_PATH = /^\/modalities\/[^/]+\/store$/;
const MODIFY_PATH = /^\/studies\/[^/]+\/modify$/;

export interface Gate {
  setMode(mode: GateMode): void;
  /**
   * 書き換えの要求（POST /studies/{id}/modify）を Orthanc へ渡し、Orthanc が仕事を作って答えた後、BFF へ答えを渡す前に
   * 1 回だけ呼ぶ（書き換えの最中に画像を届ける）。呼んだら外す
   */
  onceAfterModify(run: () => Promise<void>): void;
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
  let afterModify: (() => Promise<void>) | undefined;

  const server: Server = createServer((req, res) => {
    const pathOnly = (req.url ?? "/").split("?")[0] ?? "/";
    const drop = mode === "drop-store-response" && req.method === "POST" && STORE_PATH.test(pathOnly);
    const hook = req.method === "POST" && MODIFY_PATH.test(pathOnly) ? afterModify : undefined;
    if (hook) afterModify = undefined;
    const upstream = request(
      { host: "127.0.0.1", port: ITEST.orthancPort, method: req.method, path: req.url, headers: req.headers },
      (up) => {
        if (hook) {
          // Orthanc の答え（仕事の ID）を受けてから画像を届け、その後に BFF へ答えを渡す
          void readAll(up).then(async (body) => {
            try {
              await hook();
            } finally {
              res.writeHead(up.statusCode ?? 502, up.headers);
              res.end(body);
            }
          });
          return;
        }
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
    onceAfterModify(run) {
      afterModify = run;
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
