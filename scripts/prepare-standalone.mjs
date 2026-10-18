// next build の standalone の出力に、ブラウザへ配るファイル（.next/static・public）を写す。
// Dockerfile と同じ並びを、手元と Playwright でも使う。
import { cpSync, existsSync } from "node:fs";

cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
if (existsSync("public")) cpSync("public", ".next/standalone/public", { recursive: true });
