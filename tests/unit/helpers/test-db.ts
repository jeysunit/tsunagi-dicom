import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, type Db } from "@/lib/db";

// migration（trigger を含む）を流した本物の SQLite を、試験ごとに写して使う。

export function testDatabases(prefix: string) {
  let dir = "";
  let template = "";
  let n = 0;
  const opened: Db[] = [];
  return {
    setup() {
      dir = mkdtempSync(path.join(tmpdir(), prefix));
      template = path.join(dir, "template.db");
      execFileSync(path.resolve("node_modules/.bin/prisma"), ["migrate", "deploy"], {
        env: { ...process.env, DATABASE_URL: `file:${template}`, CHECKPOINT_DISABLE: "1" },
        stdio: "pipe",
      });
    },
    /** migration を流したデータベースの写しの URL（file:）。アプリの側（getDb）につながせる試験に使う */
    freshUrl(): string {
      const file = path.join(dir, `t${++n}.db`);
      copyFileSync(template, file);
      return `file:${file}`;
    },
    async fresh(): Promise<Db> {
      const db = await createDb(this.freshUrl());
      opened.push(db);
      return db;
    },
    async closeAll() {
      await Promise.all(opened.splice(0).map((db) => db.$disconnect()));
    },
    teardown() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
