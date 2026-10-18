import { defineConfig } from "prisma/config";

// Prisma の CLI（generate・migrate）の設定。アプリの設定の読み込みは src/lib/config.ts。
// generate はデータベースにつながないので、DATABASE_URL が無くても流れるようにする。
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "file:./data/tsunagi.db" },
});
