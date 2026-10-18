// Playwright の webServer：試験のデータベースを作り直し、standalone のサーバーを起動する。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

if (!existsSync(".next/standalone/server.js")) {
  console.error("先に npm run build を流す（.next/standalone/server.js が無い）");
  process.exit(1);
}

rmSync(".e2e", { recursive: true, force: true });
mkdirSync(".e2e");
execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], { stdio: "inherit" });
execFileSync(process.execPath, ["scripts/prepare-standalone.mjs"], { stdio: "inherit" });

const server = spawn(process.execPath, ["server.js"], { cwd: ".next/standalone", stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
