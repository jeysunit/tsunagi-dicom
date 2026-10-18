import type { Permission } from "@/lib/auth/roles";
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
}

export const EMPTY_STATE: StudyStateView = {
  inspected: false,
  read: false,
  urgent: false,
  bookmarked: false,
  rememberedViewer: null,
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
    });
  }
  return out;
}

/** 状態を1つ変える。ブックマークは利用者ごと、ほかは検査ごと */
export async function setStateFlag(
  db: Db,
  actorId: string,
  studyInstanceUid: string,
  flag: StateFlag,
  value: boolean,
  now = new Date(),
): Promise<void> {
  if (flag === "bookmarked") {
    if (value) {
      await db.studyBookmark.upsert({
        where: { actorId_studyInstanceUid: { actorId, studyInstanceUid } },
        create: { actorId, studyInstanceUid, createdAt: now },
        update: {},
      });
    } else {
      await db.studyBookmark.deleteMany({ where: { actorId, studyInstanceUid } });
    }
    return;
  }
  await db.studyState.upsert({
    where: { studyInstanceUid },
    create: { studyInstanceUid, [flag]: value, updatedBy: actorId, updatedAt: now },
    update: { [flag]: value, updatedBy: actorId, updatedAt: now },
  });
}

/** 検査ごとに覚えるビューア。null で忘れる（モダリティの既定で開く） */
export async function rememberViewer(
  db: Db,
  actorId: string,
  studyInstanceUid: string,
  viewer: ViewerId | null,
  now = new Date(),
): Promise<void> {
  await db.studyState.upsert({
    where: { studyInstanceUid },
    create: { studyInstanceUid, viewer, updatedBy: actorId, updatedAt: now },
    update: { viewer, updatedBy: actorId, updatedAt: now },
  });
}

/** モダリティごとの既定のビューア（管理の画面で変えたもの。無ければ初めの値） */
export async function modalityDefaults(db: Db): Promise<Record<ModalityGroup, string | null>> {
  const rows = await db.modalityViewerDefault.findMany();
  const out = {} as Record<ModalityGroup, string | null>;
  for (const g of MODALITY_GROUPS) {
    out[g] = rows.find((r) => r.modality === g)?.viewer ?? BUILTIN_MODALITY_DEFAULTS[g] ?? null;
  }
  return out;
}

export async function setModalityDefault(
  db: Db,
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
