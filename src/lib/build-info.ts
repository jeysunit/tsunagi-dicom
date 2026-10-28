import "server-only";
import { execFileSync } from "node:child_process";

// 「バージョン情報」の頁に出す値（docs/spec.md の 2.3）。版の正は git のタグ（docs/security-and-maintenance.md の 6.1）。
// 版はイメージを作るときに scripts/app-version.sh で作って APP_VERSION で渡す。ビルドの commit は BUILD_COMMIT。

export interface BuildInfo {
  /** アプリの版（タグの上は 0.2.0、タグより後は 0.2.0+37.g60970f9、不明は 0.0.0+unknown） */
  version: string;
  /** ビルドの commit（16 進の 7〜40 文字。渡されていない・形が違うときは undefined で、頁は行ごと出さない） */
  commit?: string;
}

export const UNKNOWN_VERSION = "0.0.0+unknown";

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;
// X.Y.Z、またはビルドの印つき（X.Y.Z+<数>.g<短い commit> / X.Y.Z+unknown）
const VERSION_PATTERN = /^\d+\.\d+\.\d+(\+[0-9A-Za-z.]+)?$/;

// 手元の開発の起動（next dev）だけ、git から直に作る。イメージには git が無いので、渡された APP_VERSION だけを使う
function versionFromGit(): string | undefined {
  try {
    return execFileSync("sh", ["scripts/app-version.sh"], { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return undefined;
  }
}

export function readBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  const passed = env.APP_VERSION?.trim();
  const candidate = passed || (env.NODE_ENV === "development" ? versionFromGit() : undefined);
  const version = candidate && VERSION_PATTERN.test(candidate) ? candidate : UNKNOWN_VERSION;
  const raw = env.BUILD_COMMIT?.trim();
  return { version, commit: raw && COMMIT_PATTERN.test(raw) ? raw.toLowerCase() : undefined };
}
