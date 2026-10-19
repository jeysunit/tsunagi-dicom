import type { Tx } from "@/lib/audit";
import type { Db } from "@/lib/db";
import { isModalityGroup, MODALITY_GROUPS, type ModalityGroup } from "@/lib/modalities";
import { BUILTIN_MODALITY_DEFAULTS, type ViewerId } from "@/lib/viewers";

// ビューアの覚え（docs/spec.md の 3.2）：検査ごとに覚えたビューアと、モダリティごとの既定のビューア。
// BFF のデータベースに持つ（画面の設定で、画像サーバーには書かない）。
// 段 2 の検査の状態の印（検像・読影・緊急・ブックマーク）は段 3 で外した（docs/spec.md の 0）。

/** 画面に出す、検査ごとのビューアの覚え */
export interface ViewerMemoryView {
  /** 検査ごとに覚えたビューア。覚えが無ければ null */
  rememberedViewer: string | null;
  /** 覚えの版（行が無ければ 0）。変えるときに添える */
  viewerVersion: number;
}

export const EMPTY_VIEWER_MEMORY: ViewerMemoryView = { rememberedViewer: null, viewerVersion: 0 };

/** 検査の一覧のビューアの覚えをまとめて読む */
export async function readViewerMemory(db: Db, uids: readonly string[]): Promise<Map<string, ViewerMemoryView>> {
  const list = [...new Set(uids)];
  const out = new Map<string, ViewerMemoryView>();
  if (list.length === 0) return out;
  const rows = await db.studyViewer.findMany({ where: { studyInstanceUid: { in: list } } });
  for (const uid of list) {
    const row = rows.find((r) => r.studyInstanceUid === uid);
    out.set(uid, { rememberedViewer: row?.viewer ?? null, viewerVersion: row?.version ?? 0 });
  }
  return out;
}

/** 変えた結果。conflict は、画面が読んだ時の版といまの版が違った（ほかの利用者が先に変えた） */
export type WriteResult = { kind: "ok"; version: number } | { kind: "conflict"; version: number };

/**
 * 検査ごとに覚えるビューア。null で忘れる（モダリティの既定で開く）。読んだ時の版（expectedVersion）が合うときだけ変え、
 * 版を1つ上げる。行が無ければ版は 0。
 * 監査の記録と同じ transaction で呼ぶ（src/lib/audit.ts の appendAuditWith）。その追記は1つのプロセスの中で
 * 一列に並ぶので、初めての行を同時に2人が作る競りは起きない。行の更新は版を条件にした文で書く（念のため）
 */
export async function rememberViewer(
  tx: Tx,
  actorId: string,
  studyInstanceUid: string,
  viewer: ViewerId | null,
  expectedVersion: number,
  now = new Date(),
): Promise<WriteResult> {
  const row = await tx.studyViewer.findUnique({ where: { studyInstanceUid } });
  const current = row?.version ?? 0;
  if (current !== expectedVersion) return { kind: "conflict", version: current };
  if (!row) {
    await tx.studyViewer.create({ data: { studyInstanceUid, viewer, version: 1, updatedBy: actorId, updatedAt: now } });
    return { kind: "ok", version: 1 };
  }
  const { count } = await tx.studyViewer.updateMany({
    where: { studyInstanceUid, version: expectedVersion },
    data: { viewer, version: expectedVersion + 1, updatedBy: actorId, updatedAt: now },
  });
  return count === 1 ? { kind: "ok", version: expectedVersion + 1 } : { kind: "conflict", version: current };
}

/** モダリティごとの既定のビューア（管理の画面で変えたもの。無ければ初めの値） */
export async function modalityDefaults(db: Db | Tx): Promise<Record<ModalityGroup, string | null>> {
  const rows = await db.modalityViewerDefault.findMany();
  const out = {} as Record<ModalityGroup, string | null>;
  for (const g of MODALITY_GROUPS) {
    out[g] = rows.find((r) => r.modality === g)?.viewer ?? BUILTIN_MODALITY_DEFAULTS[g] ?? null;
  }
  return out;
}

export async function setModalityDefault(
  db: Db | Tx,
  actorId: string,
  modality: ModalityGroup,
  viewer: ViewerId,
  now = new Date(),
): Promise<void> {
  if (!isModalityGroup(modality)) throw new Error("モダリティの群でない");
  await db.modalityViewerDefault.upsert({
    where: { modality },
    create: { modality, viewer, updatedBy: actorId, updatedAt: now },
    update: { viewer, updatedBy: actorId, updatedAt: now },
  });
}
