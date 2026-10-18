import { spawn } from "node:child_process";
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";

// 設定に誤りがあれば、どの変数かを示して起動を止める（docs/spec.md の 2.1・4）。

function startWith(overrides: Record<string, string>): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ".next/standalone",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "production", ...e2eEnv, PORT: "3101", ...overrides },
    });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`止まらなかった:\n${output}`));
    }, 20_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

const cases: [string, Record<string, string>, string][] = [
  ["SESSION_SECRET が空", { SESSION_SECRET: "" }, "SESSION_SECRET"],
  ["AUTH_MODE=local（段 1b）", { AUTH_MODE: "local" }, "AUTH_MODE: local はまだ無い"],
  ["AUTH_MODE=oidc（段 4）", { AUTH_MODE: "oidc" }, "AUTH_MODE: oidc はまだ無い"],
  [
    "AUTH_MODE=dev でモックでない（待ち受けが手元だけでも）",
    {
      BACKEND_MOCK: "false",
      BACKEND_DICOMWEB_URL: "https://pacs.example.org/dicom-web",
      BACKEND_ORTHANC_URL: "https://pacs.example.org",
      HOSTNAME: "127.0.0.1",
    },
    "AUTH_MODE: dev は BACKEND_MOCK=true のときだけ起動する",
  ],
  ["DEV_ALLOW_WRITE=true（書き込みの道は段 4 まで無い）", { DEV_ALLOW_WRITE: "true" }, "DEV_ALLOW_WRITE"],
  [
    "SESSION_SECRET と SESSION_SECRET_FILE を同時に指定",
    { SESSION_SECRET_FILE: "/nonexistent/session_secret" },
    "SESSION_SECRET_FILE: SESSION_SECRET と同時には使えない",
  ],
  ["BACKEND_KIND が誤り", { BACKEND_KIND: "pacs" }, "BACKEND_KIND"],
  ["証明書の確かめを切る", { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, "NODE_TLS_REJECT_UNAUTHORIZED"],
];

for (const [name, overrides, expected] of cases) {
  test(`起動を止める：${name}`, async () => {
    const { code, output } = await startWith(overrides);
    expect(code).toBe(1);
    expect(output).toContain(expected);
  });
}
