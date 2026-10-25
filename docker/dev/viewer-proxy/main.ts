// 開発の一式の、Orthanc のビューア（OHIF・Stone）への読み取り専用の入口。Node.js 24 の型の除去で、そのまま動かす。
import { createViewerProxy } from "./proxy.ts";

const upstream = process.env.VIEWER_PROXY_UPSTREAM ?? "http://orthanc:8042";
const url = new URL(upstream);
if (url.protocol !== "http:" || url.username || url.password) {
  console.error("VIEWER_PROXY_UPSTREAM は資格情報の無い http:// の URL にする");
  process.exit(1);
}
const port = Number(process.env.VIEWER_PROXY_PORT ?? "8080");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("VIEWER_PROXY_PORT は 1〜65535 の整数にする");
  process.exit(1);
}
const server = createViewerProxy({ upstream, timeoutMs: 60_000 });
server.listen(port, "0.0.0.0");
process.on("SIGTERM", () => server.close());
