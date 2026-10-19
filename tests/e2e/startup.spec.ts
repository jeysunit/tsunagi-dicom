import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { e2eEnv } from "../../playwright.config";

// 設定に誤りがあれば、どの変数かを示して起動を止める（docs/spec.md の 2.1・4）。

/** 規則に合わない最初の管理者のパスワード（よく使われるパスワードの一覧にある） */
const WEAK_PASSWORD_FILE = path.resolve(".e2e/weak-initial-admin-password.txt");
test.beforeAll(() => {
  mkdirSync(path.dirname(WEAK_PASSWORD_FILE), { recursive: true });
  writeFileSync(WEAK_PASSWORD_FILE, "password1\n");
});

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
  [
    "AUTH_MODE=local で利用者が1人もいず、最初の管理者の設定も無い",
    { AUTH_MODE: "local", DEV_ALLOW_WRITE: "" },
    "INITIAL_ADMIN_USERNAME: AUTH_MODE=local で利用者が1人もいない",
  ],
  [
    "最初の管理者のパスワードがファイルでない",
    { AUTH_MODE: "local", DEV_ALLOW_WRITE: "", INITIAL_ADMIN_USERNAME: "admin" },
    "INITIAL_ADMIN_PASSWORD_FILE",
  ],
  [
    "最初の管理者のパスワードのファイルを読めない",
    {
      AUTH_MODE: "local",
      DEV_ALLOW_WRITE: "",
      INITIAL_ADMIN_USERNAME: "admin",
      INITIAL_ADMIN_PASSWORD_FILE: "/nonexistent/initial_admin_password",
    },
    "INITIAL_ADMIN_PASSWORD_FILE: ファイルを読めない",
  ],
  [
    "最初の管理者のパスワードが規則に合わない（よく使われるもの）",
    {
      AUTH_MODE: "local",
      DEV_ALLOW_WRITE: "",
      INITIAL_ADMIN_USERNAME: "admin",
      INITIAL_ADMIN_PASSWORD_FILE: WEAK_PASSWORD_FILE,
    },
    "最初の管理者を作れない",
  ],
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
  // 段 4 から検証モードでは true を受けるので、検証モードのほか（local）で使ったときに止まることを確かめる
  [
    "DEV_ALLOW_WRITE=true を検証モードのほかで使う",
    { AUTH_MODE: "local", DEV_ALLOW_WRITE: "true" },
    "DEV_ALLOW_WRITE: AUTH_MODE=dev のときだけ使える",
  ],
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
