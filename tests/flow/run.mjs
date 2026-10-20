// 開発用の compose の流れの試験を流す：docker/dev/up.sh で一式（tsunagi-dicom・Orthanc・dicom-test-generator・storescp）を立て、
// Playwright（tests/flow/playwright.config.ts）を流し、終わったら片付ける。
//
//   npm ci && npx playwright install chromium   # 先に一度
//   node tests/flow/run.mjs                      # Docker（compose v2）が要る。tsunagi-dicom のイメージはこのリポジトリから作る
//
// secret のファイルは up.sh が docker/dev/secrets/（.gitignore）に作る。値は画面にも記録にも出さない。
// compose のプロジェクトは tsunagi-flow（開発用の一式の tsunagi-dev とは別。始めと終わりに volume ごと片付ける）。
// FLOW_KEEP=1 なら、終わってもコンテナを残す（調べるため。次に流すときは片付けてから立てる）。
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
process.chdir(root);

const composeFile = path.join(root, "docker/dev/compose.yaml");
const secretsDir = path.join(root, "docker/dev/secrets");

// 試験だけの compose のプロジェクトとポートにする。手元で使っている開発用の一式（プロジェクト tsunagi-dev）の
// volume を消さず、ポートもぶつけない。tests/flow/flow.spec.ts と playwright.config.ts も、この環境変数を読む
process.env.COMPOSE_PROJECT_NAME ??= "tsunagi-flow";
process.env.TSUNAGI_HTTP_PORT ??= "13000";
process.env.ORTHANC_DICOM_PORT ??= "14242";
process.env.DEV_TDG_WEB_PORT ??= "18081";
if (process.env.COMPOSE_PROJECT_NAME === "tsunagi-dev") {
  console.error("COMPOSE_PROJECT_NAME に tsunagi-dev（開発用の一式）は使えない。試験は終わったときに volume を消すため");
  process.exit(1);
}

try {
  execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
} catch {
  console.error("docker compose が使えない。Docker（compose v2）のある環境で流す（docs/round-trip-test.md）");
  process.exit(1);
}

const compose = (args, stdio = "inherit") => execFileSync("docker", ["compose", "-f", composeFile, ...args], { stdio });

let code = 1;
try {
  // 前の残りを片付けてから立てる（secret のファイルは残し、使い回す）。初めて流すときは、secret のファイルが無くて失敗してよい
  try {
    compose(["down", "--volumes", "--remove-orphans"], "ignore");
  } catch {
    // 残りが無い
  }
  execFileSync("sh", [path.join(root, "docker/dev/up.sh")], { stdio: "inherit" });
  // GitHub Actions では、secret の値を記録の伏せ字に登録する（Playwright の list の報告は、失敗した操作の記録に fill の値を出しうる）
  if (process.env.GITHUB_ACTIONS === "true") {
    for (const name of readdirSync(secretsDir).filter((n) => n.endsWith(".txt"))) {
      console.log(`::add-mask::${readFileSync(path.join(secretsDir, name), "utf8").trim()}`);
    }
  }
  code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [path.join(root, "node_modules/@playwright/test/cli.js"), "test", "-c", "tests/flow/playwright.config.ts", ...process.argv.slice(2)],
      { stdio: "inherit" },
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
  if (process.env.FLOW_KEEP !== "1") {
    try {
      compose(["down", "--volumes", "--remove-orphans"]);
    } catch {
      console.error("コンテナを片付けられなかった（docker compose -f docker/dev/compose.yaml down --volumes で片付ける）");
    }
  }
}
process.exit(code);
