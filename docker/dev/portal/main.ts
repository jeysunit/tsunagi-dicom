// 開発の一式の入口のページ（静的の1枚）。Node.js 24 の型の除去で、そのまま動かす。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { DEFAULT_PORTS, renderPortal, type PortalPorts } from "./page.ts";

const readPort = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`${name} は 1〜65535 の整数にする`);
    process.exit(1);
  }
  return n;
};

const ports: PortalPorts = {
  tsunagi: readPort("PORTAL_TSUNAGI_PORT", DEFAULT_PORTS.tsunagi),
  dtg: readPort("PORTAL_DTG_PORT", DEFAULT_PORTS.dtg),
  ris: readPort("PORTAL_RIS_PORT", DEFAULT_PORTS.ris),
};
const listenPort = readPort("PORTAL_PORT", 8080);

const html = renderPortal(ports);
const tokens = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

const server = createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end();
    return;
  }
  const path = (req.url ?? "/").split("?")[0];
  const [type, body] =
    path === "/" || path === "/index.html"
      ? ["text/html; charset=utf-8", html]
      : path === "/tokens.css"
        ? ["text/css; charset=utf-8", tokens]
        : [undefined, undefined];
  if (type === undefined || body === undefined) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(req.method === "HEAD" ? undefined : body);
});
server.listen(listenPort, "0.0.0.0");
process.on("SIGTERM", () => server.close());
