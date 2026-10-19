// 結合の試験を流す：試験の相手のコンテナ（docker/test/compose.yaml）を立て、試験だけの資格情報を作り、
// Playwright（tests/integration/playwright.config.ts）を流し、終わったら片付ける。
//
//   npm run build                      # 先に一度（standalone を作る）
//   node tests/integration/run.mjs     # Docker（compose v2）が要る
//
// 資格情報は試験のたびに乱数で作り、.e2e/itest/（.gitignore）にだけ置く。画面にも記録にも出さない。
// ITEST_KEEP=1 なら、終わってもコンテナを残す（調べるため。次に流すときは作り直す）。
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
process.chdir(root);

const composeFile = path.join(root, "docker/test/compose.yaml");
const workDir = path.join(root, ".e2e/itest");
const httpPort = process.env.ITEST_ORTHANC_HTTP_PORT ?? "18042";

if (!existsSync(".next/standalone/server.js")) {
  console.error("先に npm run build を流す（.next/standalone/server.js が無い）");
  process.exit(1);
}
try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
} catch {
  console.error("docker compose が使えない。Docker（compose v2）のある環境で流す（docs/integration-test.md）");
  process.exit(1);
}

// 試験だけの値（英数字。Orthanc の設定の JSON とファイルにそのまま書ける字だけにする）
const secret = (bytes) => randomBytes(bytes).toString("base64url").replace(/[-_]/g, "x");
const orthancUsername = "itest";
const orthancPassword = secret(24);
const adminInitial = `Itest-Init-${secret(12)}-7q`;
const adminChanged = `Itest-Own-${secret(12)}-4z`;

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true, mode: 0o700 });
// dump（架空の患者の画像の元。秘密は無い）は、DCMTK のコンテナの中の利用者（uid 10001）が読めるようにする
mkdirSync(path.join(workDir, "dumps"), { mode: 0o755 });
chmodSync(path.join(workDir, "dumps"), 0o755);
const usersFile = path.join(workDir, "orthanc-users.json");
writeFileSync(usersFile, `${JSON.stringify({ RegisteredUsers: { [orthancUsername]: orthancPassword } })}\n`);
// Orthanc のコンテナの中の利用者が読めるようにする（このフォルダは手元の利用者だけが開ける）
chmodSync(usersFile, 0o644);
writeFileSync(path.join(workDir, "backend-password.txt"), `${orthancPassword}\n`, { mode: 0o600 });

const env = {
  ...process.env,
  ITEST_ORTHANC_HTTP_PORT: httpPort,
  ITEST_DUMP_DIR: path.join(workDir, "dumps"),
  ITEST_ORTHANC_USERS_FILE: usersFile,
  ITEST_ORTHANC_USERNAME: orthancUsername,
  ITEST_ORTHANC_PASSWORD: orthancPassword,
  ITEST_ADMIN_INITIAL_PASSWORD: adminInitial,
  ITEST_ADMIN_PASSWORD: adminChanged,
  ITEST_SESSION_SECRET: randomBytes(48).toString("base64"),
};

const compose = (args, stdio = "inherit") => execFileSync("docker", ["compose", "-f", composeFile, ...args], { env, stdio });

async function waitForOrthanc() {
  const authorization = `Basic ${Buffer.from(`${orthancUsername}:${orthancPassword}`).toString("base64")}`;
  const until = Date.now() + 180_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${httpPort}/system`, { headers: { authorization }, signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const system = await res.json();
        // 版だけを出す（ほかの値は出さない）
        console.log(`Orthanc ${system.Version}（REST の API の版 ${system.ApiVersion}）が起きた`);
        const plugins = await (await fetch(`http://127.0.0.1:${httpPort}/plugins`, { headers: { authorization } })).json();
        console.log(`Orthanc のプラグイン：${plugins.join("・")}`);
        if (!plugins.includes("dicom-web")) throw new Error("DICOMweb のプラグインが有効でない");
        return;
      }
      if (res.status === 401) throw new Error("Orthanc が試験の資格情報を受けない（secret のファイルが読まれていない）");
    } catch (error) {
      if (error instanceof Error && !/fetch failed|aborted|timeout/i.test(error.message)) throw error;
    }
    if (Date.now() > until) throw new Error("Orthanc が起きるのを待ちきれなかった");
    await new Promise((r) => setTimeout(r, 1000));
  }
}

let code = 1;
try {
  compose(["down", "--volumes", "--remove-orphans"], "ignore");
  compose(["build", "storescp"]);
  // storescp が答えるようになってから Orthanc を起こす（compose の depends_on）。Orthanc が起きたかは下で確かめる
  compose(["up", "--detach", "orthanc", "storescp"]);
  await waitForOrthanc();
  code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules/@playwright/test/cli.js"), "test", "-c", "tests/integration/playwright.config.ts", ...process.argv.slice(2)],
      { env, stdio: "inherit" },
    );
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    child.on("exit", (c) => resolve(c ?? 1));
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  code = 1;
} finally {
  if (code !== 0) {
    try {
      compose(["logs", "--no-color", "--timestamps"]);
    } catch {
      // 記録を出せなくても、片付けは続ける
    }
  }
  if (process.env.ITEST_KEEP !== "1") {
    try {
      compose(["down", "--volumes", "--remove-orphans"]);
    } catch {
      console.error("コンテナを片付けられなかった（docker compose -f docker/test/compose.yaml down で消す）");
    }
  }
}
process.exit(code);
