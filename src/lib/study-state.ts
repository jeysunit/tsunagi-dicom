import type { Permission } from "@/lib/auth/roles";
import type { Tx } from "@/lib/audit";
import type { Db } from "@/lib/db";
import { isModalityGroup, MODALITY_GROUPS, type ModalityGroup } from "@/lib/modalities";
import { BUILTIN_MODALITY_DEFAULTS, type ViewerId } from "@/lib/viewers";

// 検査の状態（docs/spec.md の 3.1）と、ビューアの覚え（3.2）。BFF のデータベースに持ち、画像サーバーには書かない。
// 状態の名前（未検像・検像済・未読・既読・緊急・ブックマーク）は変えない（原則 7）。

/** 画面に出す状態（検査ごと。ブックマークは利用者ごと） */
export interface StudyStateView {
  inspected: boolean;
  read: boolean;
  urgent: boolean;
  bookmarked: boolean;
  /** 検査ごとに覚えたビューア。覚えが無ければ null */
  rememberedViewer: string | null;
  /** 状態の版（行が無ければ 0）。変えるときに添える */
  stateVersion: number;
}

export const EMPTY_STATE: StudyStateView = {
  inspected: false,
  read: false,
  urgent: false,
  bookmarked: false,
  rememberedViewer: null,
  stateVersion: 0,
};

/** 変えられる状態と、それに要る操作の権限（src/lib/auth/roles.ts） */
export const STATE_FLAGS = ["inspected", "read", "urgent", "bookmarked"] as const;
export type StateFlag = (typeof STATE_FLAGS)[number];

export const STATE_PERMISSIONS: Record<StateFlag, Permission> = {
  inspected: "study.inspect",
  read: "study.read_status",
  urgent: "study.urgent",
  bookmarked: "study.bookmark",
};

/** 検査の一覧の状態をまとめて読む */
export async function readStates(db: Db, actorId: string, uids: readonly string[]): Promise<Map<string, StudyStateView>> {
  const list = [...new Set(uids)];
  const out = new Map<string, StudyStateView>();
  if (list.length === 0) return out;
  const [rows, marks] = await Promise.all([
    db.studyState.findMany({ where: { studyInstanceUid: { in: list } } }),
    db.studyBookmark.findMany({ where: { actorId, studyInstanceUid: { in: list } } }),
  ]);
  const marked = new Set(marks.map((m) => m.studyInstanceUid));
  for (const uid of list) {
    const row = rows.find((r) => r.studyInstanceUid === uid);
    out.set(uid, {
      inspected: row?.inspected ?? false,
      read: row?.read ?? false,
      urgent: row?.urgent ?? false,
      bookmarked: marked.has(uid),
      rememberedViewer: row?.viewer ?? null,
      stateVersion: row?.version ?? 0,
    });
  }
  return out;
}

/** 変えた結果。conflict は、画面が読んだ時の版といまの版が違った（ほかの利用者が先に変えた） */
export type WriteResult = { kind: "ok"; version: number } | { kind: "conflict"; version: number };

/**
 * 検査ごとの状態の行を、読んだ時の版（expectedVersion）が合うときだけ変え、版を1つ上げる。行が無ければ版は 0。
 * 監査の記録と同じ transaction で呼ぶ（src/lib/audit.ts の appendAuditWith）。その追記は1つのプロセスの中で
 * 一列に並ぶので、初めての行を同時に2人が作る競りは起きない。行の更新は版を条件にした文で書く（念のため）
 */
async function writeStudyRow(
  tx: Tx,
  actorId: string,
  studyInstanceUid: string,
  expectedVersion: number,
  data: { inspected?: boolean; read?: boolean; urgent?: boolean; viewer?: ViewerId | null },
  now: Date,
): Promise<WriteResult> {
  const row = await tx.studyState.findUnique({ where: { studyInstanceUid } });
  const current = row?.version ?? 0;
  if (current !== expectedVersion) return { kind: "conflict", version: current };
  if (!row) {
    await tx.studyState.create({ data: { studyInstanceUid, ...data, version: 1, updatedBy: actorId, updatedAt: now } });
    return { kind: "ok", version: 1 };
  }
  const { count } = await tx.studyState.updateMany({
    where: { studyInstanceUid, version: expectedVersion },
    data: { ...data, version: expectedVersion + 1, updatedBy: actorId, updatedAt: now },
  });
  return count === 1 ? { kind: "ok", version: expectedVersion + 1 } : { kind: "conflict", version: current };
}

/**
 * 状態を1つ変える。検像・読影・緊急は検査ごと（版で古い画面からの上書きを断る）、ブックマークは利用者ごと
 * （本人だけのもので、同じ値にするだけなので版を見ない）
 */
export async function setStateFlag(
  tx: Tx,
  actorId: string,
  studyInstanceUid: string,
  flag: StateFlag,
  value: boolean,
  expectedVersion: number,
  now = new Date(),
): Promise<WriteResult> {
  if (flag === "bookmarked") {
    const mark = await tx.studyBookmark.findUnique({ where: { actorId_studyInstanceUid: { actorId, studyInstanceUid } } });
    if (value && !mark) await tx.studyBookmark.create({ data: { actorId, studyInstanceUid, createdAt: now } });
    if (!value && mark) await tx.studyBookmark.deleteMany({ where: { actorId, studyInstanceUid } });
    return { kind: "ok", version: expectedVersion };
  }
  return writeStudyRow(tx, actorId, studyInstanceUid, expectedVersion, { [flag]: value }, now);
}

/** 検査ごとに覚えるビューア。null で忘れる（モダリティの既定で開く）。版は状態と同じ行のもの */
export async function rememberViewer(
  tx: Tx,
  actorId: string,
  studyInstanceUid: string,
  viewer: ViewerId | null,
  expectedVersion: number,
  now = new Date(),
): Promise<WriteResult> {
  return writeStudyRow(tx, actorId, studyInstanceUid, expectedVersion, { viewer }, now);
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
