import type { Role } from "@/lib/auth/roles";
import { inDateRange, studyFromDicomJson } from "@/lib/backend/dicom-json";
import type { Backend, SeriesSummary, StudyQuery, StudySearch, StudySummary } from "@/lib/backend/types";
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
  advancedQuery,
  attachSearchNames,
  blockedConditions,
  dateQuery,
  DEFAULT_FILTER,
  FACET_DATES,
  matchesFilter,
  todayIn,
  type FacetDate,
  type StudyFacets,
  type StudyFilter,
} from "@/lib/study-filter";
import { EMPTY_VIEWER_MEMORY, modalityDefaults, readViewerMemory } from "@/lib/viewer-memory";
import { resolveDefaultViewer, type ViewerInfo } from "@/lib/viewers";

// 検査の一覧と詳細（画面の API と、一覧の頁の最初の描画で同じものを使う）。
// 画像サーバーの応答と BFF のビューアの覚えを組み立て、役割の許可の一覧（src/lib/fields.ts）で絞った形にしてから返す。

export interface ListDeps {
  /** importedStudyUids が無ければ、インポートの印を出さない */
  backend: Pick<Backend, "searchStudies"> & Partial<Pick<Backend, "importedStudyUids">>;
  /** ビューアの覚え（検査ごと・モダリティごと）を読む。無ければ覚えは空 */
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
  /** 監査の記録に残す、件数を数えた条件・範囲・件数（ブラウザへは返さない） */
  facetAudit: FacetAudit;
  /** 監査の記録に残す、返した検査（ブラウザへは返さない） */
  returned: StudySummary[];
  /** 画像サーバーへ求めた時刻（ミリ秒） */
  fetchedAt: number;
}

/**
 * インポートの印のある検査（Orthanc のラベル。段 6）。読めなければ印を出さずに一覧を出す（印は補いの情報で、一覧を止めない）。
 * 古い Orthanc（ラベルの無い 1.12.0 より前）でも同じ
 */
async function importedUids(deps: ListDeps): Promise<Set<string>> {
  if (!deps.backend.importedStudyUids) return new Set();
  try {
    return await deps.backend.importedStudyUids();
  } catch (error) {
    console.error("インポートの印を読めなかった", error instanceof Error ? error.name : "unknown");
    return new Set();
  }
}

async function decorate(deps: ListDeps, studies: StudySummary[]) {
  const uids = studies.map((s) => s.studyInstanceUid);
  const [memory, defaults] = deps.db
    ? await Promise.all([readViewerMemory(deps.db, uids), modalityDefaults(deps.db)])
    : [new Map(), null];
  const allowlist = allowlistFor(deps.role, deps.allowlists);
  const imported = allowlist.study.includes("imported") && studies.length > 0 ? await importedUids(deps) : new Set<string>();
  return studies.map((s) => {
    const remembered = memory.get(s.studyInstanceUid) ?? EMPTY_VIEWER_MEMORY;
    const group = primaryGroup(s.modalities);
    const viewer = resolveDefaultViewer(remembered.rememberedViewer, group && defaults ? defaults[group] : null, deps.viewers ?? []);
    const view = projectStudy(studyRecord(s, remembered, viewer, imported.has(s.studyInstanceUid)), allowlist);
    // 氏名の検索は第3〜5成分まで含める（画面に出す値は姓と名のまま。検索にだけ使うので、行の object に結びつけて持つ）
    attachSearchNames(view, s.patientName);
    return { summary: s, view };
  });
}

/**
 * 見出しごとの件数。許可の一覧で絞った後の項目だけから数える（見えない項目の件数は、キーごと出さない）。
 * 各見出しの件数は、それを押したあとの一覧の件数と同じ：モダリティの件数は横断の検索を、
 * 検査日の件数はモダリティと横断の検索を、いまの値のまま当てる。
 * `dateViews` は検査日で絞らない一覧（検査日の件数の元。いまの一覧が全期間ならそれと同じ）
 */
export function computeFacets(
  views: readonly StudyView[],
  dateViews: readonly StudyView[] | null,
  filter: StudyFilter,
  today: SimpleDate,
  fields: readonly string[],
  /** 検索が上限に届かず、全部を数えられたか（list：いまの一覧、date：検査日の件数の元）。既定は両方とも全部 */
  complete: { list: boolean; date: boolean } = { list: true, date: true },
): StudyFacets {
  const facets: StudyFacets = {};
  if (fields.includes("modalities")) {
    // 群ごとの件数は、選んだモダリティを外した一覧の中の、その群の検査の数（複数選んでも、その群だけの数）
    const base = views.filter((v) => matchesFilter(v, { ...filter, modalities: undefined }));
    const modality: NonNullable<StudyFacets["modality"]> = { all: base.length };
    for (const g of MODALITY_GROUPS) modality[g] = base.filter((v) => v.modalities && studyInGroup(v.modalities, g)).length;
    facets.modality = modality;
  }
  if (facets.modality && !complete.list) facets.atLeast = { ...facets.atLeast, list: true };
  // 検査日の件数の元が取れなかったとき（null）は、検査日の件数を出さない（一覧は出す）
  if (fields.includes("studyDate") && dateViews) {
    const base = dateViews.filter((v) => matchesFilter(v, filter));
    const date: NonNullable<StudyFacets["date"]> = {};
    const inexact: FacetDate[] = [];
    // 検索は検査日の新しい側から欠けなく上限まで（searchStudies）。いちばん古い検査の日より後から始まる範囲は、
    // 全部が入っているので確定。そうでなければ「以上」
    const oldest = dateViews.map((v) => v.studyDate ?? "").filter((d) => /^\d{8}$/.test(d)).sort()[0];
    for (const d of FACET_DATES) {
      const range = dateQuery({ date: d }, today);
      date[d] = base.filter((v) => inDateRange(v.studyDate ?? "", range)).length;
      const covered = complete.date || (oldest !== undefined && range.dateFrom !== undefined && oldest < range.dateFrom);
      if (!covered) inexact.push(d);
    }
    facets.date = date;
    if (inexact.length > 0) facets.atLeast = { ...facets.atLeast, date: inexact };
  }
  return facets;
}

/** 件数を数えたことの、監査の記録の補足（患者の値は入れない。検索の語は有無だけ） */
export interface FacetAudit {
  /** 数えた検査の範囲：all-dates＝全期間（一覧が全期間か、別にもう 1 回検索した）、none＝検査日の件数は数えなかった */
  dateScope: "all-dates" | "none";
  /** 全期間の検索を、いまの一覧とは別に求めたか */
  extraSearch: boolean;
  /** 検査日の件数のために読んだ検査の数と、画像サーバーに読みきれなかった検査があったか（上限に届いたか） */
  fetched: number;
  limited: boolean;
  /** 追加の検索が失敗して、検査日の件数を出さなかった */
  failed: boolean;
  /** 件数を数えたときの絞り込み（検索の語は有無だけ） */
  filter: { date: string; from?: string; to?: string; modality?: string; query: boolean; conditions?: string[]; blocked?: string[] };
  /** 返した件数（数だけ） */
  counts: { date?: Record<string, number>; modality?: Record<string, number> };
  /** 件数が「以上」（上限に届いた）ものがあったか */
  atLeast: boolean;
}

export async function listStudies(deps: ListDeps, filter: StudyFilter = DEFAULT_FILTER): Promise<StudyListResult> {
  const today = todayIn(deps.timeZone ?? "Asia/Tokyo", deps.now);
  const fields = allowlistFor(deps.role, deps.allowlists).study;
  // 検査日を許されていない役割には、検査日の絞り込みも効かせない（隠した項目で探せないように。原則 8）
  const dateAllowed = fields.includes("studyDate");
  const fetchedAt = Date.now();
  // 詳細条件（生年月日・性別・受付番号・検査名）は、許可の一覧に載った項目の条件だけを画像サーバーへ渡す。
  // 許可されていない項目の条件が付いていたら、条件を外して広げず、0 件にする（隠した項目で探せないように。原則 8。
  // 横断の検索が、隠した項目では合わないのと同じ向き）
  const advanced = advancedQuery(filter, fields);
  const blocked = blockedConditions(filter, fields);
  const search = (query: StudyQuery): Promise<StudySearch> =>
    blocked.length > 0 ? Promise.resolve({ studies: [], complete: true }) : deps.backend.searchStudies(STUDY_LIMIT, query);
  const listSearch = await search({ ...(dateAllowed ? dateQuery(filter, today) : {}), ...advanced });
  const studies = listSearch.studies;
  const decorated = await decorate(deps, studies);
  const rows = decorated.filter((r) => matchesFilter(r.view, filter));
  // 検査日の件数の元：いまの一覧が全期間でなければ、全期間をもう一度読む（件数を数えるだけ。監査の記録の「返した検査」には入れない）
  // 追加の検索が失敗したら、検査日の件数だけを出さず、一覧は出す
  const extraSearch = dateAllowed && filter.date !== "all";
  let dateRows: typeof decorated | null = decorated;
  let dateFetched = studies.length;
  let dateComplete = listSearch.complete;
  let failed = false;
  if (extraSearch) {
    try {
      // 検査日だけを外す（詳細条件は、いまの一覧と同じに当てる。押したあとの一覧の件数と合うように）
      const all = await search(advanced);
      dateFetched = all.studies.length;
      dateComplete = all.complete;
      dateRows = await decorate(deps, all.studies);
    } catch (error) {
      console.error("検査日の件数のための検索に失敗した", error instanceof Error ? error.name : "unknown");
      dateRows = null;
      failed = true;
    }
  }
  // 確定と出すのは、画像サーバーが条件に合う検査を全部返したときだけ（返した数ではなく、続きがあるかで決める。PS3.18 8.3.4.4.1）
  const listExact = listSearch.complete;
  const facets = computeFacets(
    decorated.map((r) => r.view),
    dateRows?.map((r) => r.view) ?? null,
    filter,
    today,
    fields,
    { list: listExact, date: dateComplete },
  );
  return {
    count: { count: rows.length, exact: listExact },
    studies: rows.map((r) => r.view),
    facets,
    facetAudit: {
      dateScope: facets.date ? "all-dates" : "none",
      extraSearch,
      fetched: dateFetched,
      limited: !dateComplete,
      failed,
      filter: {
        date: filter.date,
        ...(filter.from ? { from: filter.from } : {}),
        ...(filter.to ? { to: filter.to } : {}),
        // 選んだ群の名前（複数ならコンマで区切る）
        ...(filter.modalities?.length ? { modality: filter.modalities.join(",") } : {}),
        query: !!filter.q,
        // 詳細条件は、効かせた条件の名前だけ（値は患者の値なので入れない）
        ...(Object.keys(advanced).length > 0 ? { conditions: Object.keys(advanced) } : {}),
        // 許可されていない項目の条件（あれば 0 件にした）
        ...(blocked.length > 0 ? { blocked } : {}),
      },
      counts: {
        ...(facets.date ? { date: facets.date } : {}),
        ...(facets.modality ? { modality: facets.modality } : {}),
      },
      atLeast: !!facets.atLeast,
    },
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
