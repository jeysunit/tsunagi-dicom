import type { StatusKind } from "@/components/ui/status-badge";
import { SENT_STATUSES, type SentStatus, type SentView } from "@/lib/fields";
import { normalizeForSearch } from "@/lib/study-filter";

// 送信一覧の画面の計算（docs/spec.md の 3.4）。期間は BFF で読み、送信先・患者ID と氏名・状態の絞り込みとページ送りは、
// 読んだ範囲（上限 1,000 件）の中で画面が行う（受信一覧と同じ。Orthanc へは求め直さない）。

/** 状態の札の語と形（docs/spec.md の 2.2、docs/design-system/components.md の「状態の札」） */
export const SENT_STATUS_LABELS: Record<SentStatus, string> = {
  pending: "送信待ち",
  running: "送信中",
  sent: "送信完了",
  failed: "送信失敗",
  unknown: "結果不明",
};
export const SENT_STATUS_KINDS: Record<SentStatus, StatusKind> = {
  pending: "plan",
  running: "wait",
  sent: "ok",
  failed: "ng",
  unknown: "unknown",
};

export const PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;

export interface SentFilter {
  /** 送信先の名称（空ならすべて） */
  destination: string;
  /** 患者ID・氏名（漢字・かな） */
  text: string;
  /** 状態（all ならすべて） */
  status: SentStatus | "all";
}

export const EMPTY_SENT_FILTER: SentFilter = { destination: "", text: "", status: "all" };

/** 送信先と患者ID・氏名で絞る（状態は別。状態の要約の件数は、状態で絞る前の行で数える） */
export function matchesSent(item: SentView, filter: Pick<SentFilter, "destination" | "text">): boolean {
  if (filter.destination && item.destination !== filter.destination) return false;
  const needle = normalizeForSearch(filter.text);
  if (!needle) return true;
  return [item.study.patientId, item.study.patientName, item.study.patientKana].some(
    (v) => typeof v === "string" && normalizeForSearch(v).includes(needle),
  );
}

/** 状態ごとの件数（すべてを含む） */
export function statusCounts(items: readonly SentView[]): Record<SentStatus | "all", number> {
  const out = { all: items.length } as Record<SentStatus | "all", number>;
  for (const s of SENT_STATUSES) out[s] = 0;
  for (const item of items) if (item.status) out[item.status] += 1;
  return out;
}

/** 読んだ行にある送信先（選択の欄の選択肢）。選んでいる送信先は、読み直して消えても残す */
export function destinations(items: readonly SentView[], selected: string): string[] {
  return [...new Set([...items.map((i) => i.destination ?? ""), selected].filter(Boolean))].sort();
}

export interface PageSlice<T> {
  rows: T[];
  /** 1 から数えるページ（範囲の外を指したら、いちばん近いページ） */
  page: number;
  pages: number;
  /** 何件目から何件目か（1 から。行が無ければ 0） */
  first: number;
  last: number;
}

export function pageSlice<T>(items: readonly T[], page: number, size: number): PageSlice<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (p - 1) * size;
  const rows = items.slice(start, start + size);
  return { rows, page: p, pages, first: rows.length ? start + 1 : 0, last: start + rows.length };
}

/** 検査一覧で、その検査を選んだ形で開く URL（受信一覧の「検査一覧で表示」と同じ形） */
export function sentStudyHref(item: SentView): string | null {
  const params = new URLSearchParams();
  if (item.study.patientId) params.set("q", item.study.patientId);
  if (item.study.studyInstanceUid) params.set("studyUid", item.study.studyInstanceUid);
  return params.size > 0 ? `/?${params}` : null;
}

/**
 * 札の隣（詳細）に出す文：なぜか＋次にすること（docs/design-system/writing.md。札が事象を言うので繰り返さない）。
 * 結果不明は、成功とも失敗とも書かず、確かめる対象と、それまでできないことを書く
 */
export function sentStatusNote(item: SentView): string {
  const to = item.destination || "送信先";
  switch (item.status) {
    case "failed":
      // 原因（Orthanc の誤りの番号と英語の原文）は画面に出さない（docs/design-system/writing.md）
      return `原因はこの画面では分かりません。接続先の画面で ${to} の接続確認をしてから、検査の詳細の「送信」から再送信してください。`;
    case "unknown":
      return `届いたか分かりません。${to} にこの検査が届いているかを確認するまで、同じ送信先へ再送信しないでください。管理者でないユーザーは、管理者に確認を頼んでください。`;
    default:
      return "";
  }
}

/** 1,000 件を超えたときの知らせ（docs/design-system/components.md の「送受信の一覧」） */
export const sentLimitNotice = (limit: number) =>
  `送信ジョブが ${limit.toLocaleString("en-US")} 件を超えたため、新しい ${limit.toLocaleString("en-US")} 件だけを出しています。期間を狭めてください。`;
