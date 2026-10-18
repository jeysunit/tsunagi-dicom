import "server-only";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@/generated/prisma/client";
import { getConfig } from "@/lib/config";

export type Db = PrismaClient;

/** SQLite（WAL）につなぐ。試験では一時のファイルの URL を渡す */
export async function createDb(databaseUrl: string): Promise<Db> {
  const db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databaseUrl }) });
  await db.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  return db;
}

let shared: Promise<Db> | undefined;

export function getDb(): Promise<Db> {
  shared ??= createDb(getConfig().databaseUrl);
  return shared;
}
