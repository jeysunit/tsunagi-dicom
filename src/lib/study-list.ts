import type { Role } from "@/lib/auth/roles";
import { inDateRange, studyFromDicomJson } from "@/lib/backend/dicom-json";
import type { Backend, SeriesSummary, StudySummary } from "@/lib/backend/types";
import { STUDY_LIMIT } from "@/lib/backend/types";
import type { Db } from "@/lib/db";
import {
  allowlistFor,
  projectStudy,
  seriesView,
  studyRecord,
  type FieldAllowlistMap,
  type SeriesView,
  type StudyView,
} from "@/lib/fields";
import type { SimpleDate } from "@/lib/format/japanese-date";
import { MODALITY_GROUPS, primaryGroup, studyInGroup } from "@/lib/modalities";
import {
  dateQuery,
  DEFAULT_FILTER,
  FACET_DATES,
  matchesFilter,
  STATUS_FIELD,
  STATUS_FILTERS,
  statusMatches,
  todayIn,
  type StudyFacets,
  type StudyFilter,
} from "@/lib/study-filter";
import { EMPTY_STATE, modalityDefaults, readStates } from "@/lib/study-state";
import { resolveDefaultViewer, type ViewerInfo } from "@/lib/viewers";

// 検査の一覧と詳細（画面の API と、一覧の頁の最初の描画で同じものを使う）。
// 画像サーバーの応答と BFF の状態を組み立て、役割の許可の一覧（src/lib/fields.ts）で絞った形にしてから返す。

export interface ListDeps {
  backend: Pick<Backend, "searchStudies">;
  /** 状態（検像・読影・緊急・ブックマーク）とビューアの覚えを読む。無ければ状態は空 */
  db?: Db;
  role: Role;
  actorId: string;
  viewers?: readonly ViewerInfo[];
  timeZone?: string;
  now?: Date;
  allowlists?: FieldAllowlistMap;
}

export interface StudyListResult {
  /** 合った検査の数。画像サーバーの答えが上限に届いたら exact=false（「以上」） */
  count: { count: number; exact: boolean };
  /** ブラウザへ返す形（許可の一覧で絞ったもの） */
  studies: StudyView[];
  /** 見出しごとの件数（許可の一覧に載っていない項目の見出しは含めない） */
  facets: StudyFacets;
  /** 監査の記録に残す、返した検査（ブラウザへは返さない） */
  returned: StudySummary[];
  /** 画像サーバーへ求めた時刻（ミリ秒） */
  fetchedAt: number;
}

async function decorate(deps: ListDeps, studies: StudySummary[]) {
  const uids = studies.map((s) => s.studyInstanceUid);
  const [states, defaults] = deps.db
    ? await Promise.all([readStates(deps.db, deps.actorId, uids), modalityDefaults(deps.db)])
    : [new Map(), null];
  const allowlist = allowlistFor(deps.role, deps.allowlists);
  return studies.map((s) => {
    const state = states.get(s.studyInstanceUid) ?? EMPTY_STATE;
    const group = primaryGroup(s.modalities);
    const viewer = resolveDefaultViewer(state.rememberedViewer, group && defaults ? defaults[group] : null, deps.viewers ?? []);
    return { summary: s, view: projectStudy(studyRecord(s, state, viewer), allowlist) };
  });
}

/**
 * 見出しごとの件数。許可の一覧で絞った後の項目だけから数える（見えない項目の件数は、キーごと出さない）。
 * 各見出しの件数は、それを押したあとの一覧の件数と同じ：モダリティの件数は状態と横断の検索を、
 * 状態の件数はモダリティと横断の検索を、検査日の件数は両方と横断の検索を、いまの値のまま当てる。
 * `dateViews` は検査日で絞らない一覧（検査日の件数の元。いまの一覧が全期間ならそれと同じ）
 */
export function computeFacets(
  views: readonly StudyView[],
  dateViews: readonly StudyView[],
  filter: StudyFilter,
  today: SimpleDate,
  fields: readonly string[],
): StudyFacets {
  const facets: StudyFacets = {};
  if (fields.includes("modalities")) {
    const base = views.filter((v) => matchesFilter(v, { ...filter, modality: undefined }));
    const modality: NonNullable<StudyFacets["modality"]> = { all: base.length };
    for (const g of MODALITY_GROUPS) modality[g] = base.filter((v) => v.modalities && studyInGroup(v.modalities, g)).length;
    facets.modality = modality;
  }
  const statusKinds = STATUS_FILTERS.filter((s) => fields.includes(STATUS_FIELD[s]));
  if (statusKinds.length > 0) {
    const base = views.filter((v) => matchesFilter(v, { ...filter, status: undefined }));
    const status: NonNullable<StudyFacets["status"]> = { all: base.length };
    for (const s of statusKinds) status[s] = base.filter((v) => statusMatches(v, s)).length;
    facets.status = status;
  }
  if (fields.includes("studyDate")) {
    const base = dateViews.filter((v) => matchesFilter(v, filter));
    const date: NonNullable<StudyFacets["date"]> = {};
    for (const d of FACET_DATES) {
      const range = dateQuery({ date: d }, today);
      date[d] = base.filter((v) => inDateRange(v.studyDate ?? "", range)).length;
    }
    facets.date = date;
  }
  return facets;
}

export async function listStudies(deps: ListDeps, filter: StudyFilter = DEFAULT_FILTER): Promise<StudyListResult> {
  const today = todayIn(deps.timeZone ?? "Asia/Tokyo", deps.now);
  const fields = allowlistFor(deps.role, deps.allowlists).study;
  // 検査日を許されていない役割には、検査日の絞り込みも効かせない（隠した項目で探せないように。原則 8）
  const dateAllowed = fields.includes("studyDate");
  const fetchedAt = Date.now();
  const studies = await deps.backend.searchStudies(STUDY_LIMIT, dateAllowed ? dateQuery(filter, today) : {});
  const decorated = await decorate(deps, studies);
  const rows = decorated.filter((r) => matchesFilter(r.view, filter));
  // 検査日の件数の元：いまの一覧が全期間でなければ、全期間をもう一度読む（件数を数えるだけ。監査の記録の「返した検査」には入れない）
  const dateRows = dateAllowed && filter.date !== "all" ? await decorate(deps, await deps.backend.searchStudies(STUDY_LIMIT, {})) : decorated;
  return {
    count: { count: rows.length, exact: studies.length < STUDY_LIMIT },
    studies: rows.map((r) => r.view),
    facets: computeFacets(
      decorated.map((r) => r.view),
      dateRows.map((r) => r.view),
      filter,
      today,
      fields,
    ),
    returned: rows.map((r) => r.summary),
    fetchedAt,
  };
}

export interface StudyDetailResult {
  study: StudyView;
  series: SeriesView[];
  summary: StudySummary;
}

/**
 * 1件の検査の詳細（検査・患者の情報と、シリーズの並び）。検査が見つからなければ null。
 * 検査の情報は QIDO-RS の検査の検索（StudyInstanceUID で1件）から組み立てる
 */
export async function studyDetail(
  deps: ListDeps & { backend: Pick<Backend, "searchStudies" | "searchSeries" | "studyDataset"> },
  studyInstanceUid: string,
): Promise<StudyDetailResult | null> {
  const dataset = await deps.backend.studyDataset(studyInstanceUid);
  if (!dataset) return null;
  const summary = studyFromDicomJson(dataset);
  const [[row], series] = await Promise.all([decorate(deps, [summary]), deps.backend.searchSeries(studyInstanceUid)]);
  const allowlist = allowlistFor(deps.role, deps.allowlists);
  return {
    study: row!.view,
    series: series.map((s: SeriesSummary) => seriesView(s, allowlist)),
    summary,
  };
}
