import "server-only";
import { version } from "../../package.json";

// 「バージョン情報」の頁に出す値（docs/spec.md の 2.3）。版は package.json、ビルドの commit はイメージを作るときに渡す BUILD_COMMIT。

export interface BuildInfo {
  /** アプリの版（package.json の version） */
  version: string;
  /** ビルドの commit（16 進の 7〜40 文字。渡されていない・形が違うときは undefined で、頁は行ごと出さない） */
  commit?: string;
}

const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export function readBuildInfo(env: Record<string, string | undefined> = process.env): BuildInfo {
  const raw = env.BUILD_COMMIT?.trim();
  return { version, commit: raw && COMMIT_PATTERN.test(raw) ? raw.toLowerCase() : undefined };
}
