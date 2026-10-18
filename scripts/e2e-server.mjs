// Playwright の webServer：試験のデータベースを作り直し、standalone のサーバーを起動する。
// 検証モード（AUTH_MODE=dev）と AUTH_MODE=local の2つを同時に起動するので、消すのは DATABASE_URL のファイルだけにする。
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

if (!existsSync(".next/standalone/server.js")) {
  console.error("先に npm run build を流す（.next/standalone/server.js が無い）");
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? "";
if (!url.startsWith("file:")) {
  console.error("DATABASE_URL は file: で始める");
  process.exit(1);
}
const dbFile = path.resolve(url.slice("file:".length));
mkdirSync(path.dirname(dbFile), { recursive: true });
for (const suffix of ["", "-wal", "-shm", "-journal"]) rmSync(`${dbFile}${suffix}`, { force: true });

execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], { stdio: "inherit" });

// AUTH_MODE=local の試験：最初の管理者のパスワードを、秘密のファイルとして置く（試験だけの値）
if (process.env.INITIAL_ADMIN_PASSWORD_FILE && process.env.E2E_INITIAL_ADMIN_PASSWORD) {
  writeFileSync(process.env.INITIAL_ADMIN_PASSWORD_FILE, `${process.env.E2E_INITIAL_ADMIN_PASSWORD}\n`, { mode: 0o600 });
}
if (process.env.E2E_SKIP_PREPARE !== "true") {
  execFileSync(process.execPath, ["scripts/prepare-standalone.mjs"], { stdio: "inherit" });
}

const server = spawn(process.execPath, ["server.js"], { cwd: ".next/standalone", stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("exit", (code) => process.exit(code ?? 0));
