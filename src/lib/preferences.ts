import type { Db } from "@/lib/db";

// 利用者ごとの画面の設定（docs/spec.md の 2）。いまは地の色だけ。
// 文字を読む画面は明るい地を既定にし、利用者が暗い地を選んだら覚える。

export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "light";

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** 利用者の地の色。覚えが無い・読めない値は既定（明るい地） */
export async function getTheme(db: Db, actorId: string): Promise<Theme> {
  const row = await db.userPreference.findUnique({ where: { actorId } });
  return isTheme(row?.theme) ? row.theme : DEFAULT_THEME;
}

export async function setTheme(db: Db, actorId: string, theme: Theme, now = new Date()): Promise<void> {
  await db.userPreference.upsert({
    where: { actorId },
    create: { actorId, theme, updatedAt: now },
    update: { theme, updatedAt: now },
  });
}
