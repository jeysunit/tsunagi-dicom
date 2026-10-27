import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// コンテナの中で流すコマンド（src/cli）を、Node で動く 1 つのファイルにまとめる（npm run build:cli → dist/cli）。
// イメージの本体は Next.js の standalone で、src の TypeScript も `@/` の別名も無いため。
// `@/` の中身（src/lib・src/generated）と、JavaScript の依存（zod・Prisma など）は全部取り込む。
// standalone の /app/node_modules には、Next.js が自分の出力に取り込んだ依存が無い、または一部のファイルしか無いため。
// 取り込まないのは、ネイティブの部品を持つ better-sqlite3 だけ。Dockerfile が、イメージの中の本体
// （standalone が持つもの）へ /app/cli/node_modules/better-sqlite3 からたどれるようにする。
const NATIVE_FROM_IMAGE = ["better-sqlite3"];

export default defineConfig({
  ssr: { noExternal: true, external: NATIVE_FROM_IMAGE },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Next.js の外では server-only の印を空にする
      "server-only": fileURLToPath(new URL("./tests/unit/stubs/server-only.ts", import.meta.url)),
    },
  },
  build: {
    ssr: true,
    target: "node24",
    outDir: "dist/cli",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      input: { "reset-admin-password": fileURLToPath(new URL("./src/cli/reset-admin-password-main.ts", import.meta.url)) },
      // 分けた塊も .mjs にする（/app/package.json に "type": "module" が無く、.js だと読み直しの警告が出る）
      output: { format: "esm", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
    },
  },
});
