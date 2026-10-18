import "server-only";
import type { Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import type { ListDeps } from "@/lib/study-list";
import { availableViewers } from "@/lib/viewers";

// 画面の API と頁で使う、いまの利用者の検査の一覧・詳細の材料。
export async function screenDeps(session: Session) {
  const config = getConfig();
  return {
    backend: getBackend(),
    db: await getDb(),
    role: session.role,
    actorId: session.actorId,
    viewers: availableViewers(config.viewers),
    timeZone: config.timeZone,
  } satisfies ListDeps;
}
