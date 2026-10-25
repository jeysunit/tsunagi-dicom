// 開発の一式だけの、読み取り専用の入口（docker/dev/viewer-proxy/main.ts が使う）。
// ブラウザが Orthanc のビューアの plugin（OHIF・Stone）を開くために、Orthanc の REST をホストの 127.0.0.1 に見せる。
// GET と HEAD だけを通し、書き込み（POST・PUT・DELETE など）は Orthanc に届かせず 405 で断る。
// 認証は Orthanc のもの（Authorization をそのまま渡す。この入口は資格情報を持たない）。
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";

export interface ProxyOptions {
  /** Orthanc の REST の根（例：http://orthanc:8042） */
  upstream: string;
  timeoutMs: number;
}

const READ_METHODS = new Set(["GET", "HEAD"]);
/** 上流へ渡さないヘッダー（接続ごとのもの） */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);

export function isReadMethod(method: string | undefined): boolean {
  return READ_METHODS.has((method ?? "").toUpperCase());
}

/** 上流へ渡すヘッダー。接続ごとのヘッダーは落とす。Host は上流の Orthanc に向けず、ブラウザが開いた宛先のままにする（DICOMweb の URL がそれで組まれる） */
export function forwardHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = value;
  }
  return out;
}

export function createViewerProxy(options: ProxyOptions): Server {
  const upstream = new URL(options.upstream);
  return createServer((req, res) => {
    if (!isReadMethod(req.method)) {
      // 送られてくる本体は読み捨て、接続は閉じる
      req.resume();
      res.writeHead(405, { allow: "GET, HEAD", connection: "close", "content-type": "text/plain; charset=utf-8" });
      res.end("読み取り専用の入口です\n");
      return;
    }
    const proxied = httpRequest(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers),
        timeout: options.timeoutMs,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    proxied.on("timeout", () => proxied.destroy(new Error("timeout")));
    proxied.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Orthanc につながらない\n");
    });
    req.on("aborted", () => proxied.destroy());
    proxied.end();
  });
}
