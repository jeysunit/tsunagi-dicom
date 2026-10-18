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

/**
 * 1つのつなぎを使い回す。つなぐのに失敗したら覚えず、次の呼び出しでつなぎ直す
 * （一度の失敗、例えばデータベースのファイルの場所がまだ無いときの失敗を、プロセスの終わりまで返し続けない）
 */
export function shareUntilFailure<T>(open: () => Promise<T>): () => Promise<T> {
  let shared: Promise<T> | undefined;
  return () => {
    if (!shared) {
      const attempt = open();
      shared = attempt;
      attempt.catch(() => {
        if (shared === attempt) shared = undefined;
      });
    }
    return shared;
  };
}

export const getDb: () => Promise<Db> = shareUntilFailure(() => createDb(getConfig().databaseUrl));
