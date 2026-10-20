"use client";

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, ChevronRight, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PendingText, ProgressBar, useDelayedPending } from "@/components/ui/pending";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { StudyDetailPanel } from "@/components/studies/study-detail";
import { openInViewer, ViewerMenu } from "@/components/studies/viewer-menu";
import { getJson } from "@/lib/client/api";
import {
  getServerSplit,
  getSplit,
  setSplit,
  SPLIT_MAX,
  SPLIT_MIN,
  splitAfterKey,
  subscribeSplit,
} from "@/lib/client/split-position";
import { getNarrow, getServerNarrow, subscribeNarrow } from "@/lib/client/narrow";
import type { StudyView } from "@/lib/fields";
import { formatAge, formatBirthWareki, formatDicomTime, formatSlashDate, sexLabel } from "@/lib/format/japanese-date";
import { MODALITY_GROUPS, modalityGroupOf, type ModalityGroup } from "@/lib/modalities";
import {
  DATE_LABELS,
  DEFAULT_FILTER,
  FACET_DATES,
  filterToSearchParams,
  MAX_QUERY_LENGTH,
  type StudyFacets,
  type StudyFilter,
} from "@/lib/study-filter";
import { cn } from "@/lib/utils";

// 検査の一覧（docs/spec.md の 3.1）。すぐ絞れる見出し（1 行・件数つき）・1 件 1 行の一覧（14px）・詳細のパネル・ビューアの選び分け。
// 上下に分ける：上＝絞り込みと一覧（この中だけでスクロール）、下＝選んだ検査の詳細。頁全体はスクロールさせない。
// データは TanStack Query で画面の API（/api/studies）から取る。最初の描画はサーバーの側で取った値を使う。
// 絞り込みの値は頁の URL に持つ（開き直し・戻るでも同じ絞り込み）。

export interface StudyListData {
  count: { count: number; exact: boolean };
  studies: StudyView[];
  /** 見出しごとの件数（BFF が数える。許可されていない項目の見出しは含まれない） */
  facets: StudyFacets;
}

/** 矢印のキーで行を移したあと、詳細を読みに行くまでの待ち（ミリ秒）。通り過ぎた行を読まない */
const DETAIL_DELAY_MS = 300;
/** 削除が終わったことの知らせを出しておく時間（ミリ秒。docs/spec.md の 3.5） */
const NOTICE_MS = 10_000;
/** 一覧の最小の高さ（見出しと 7 行ほど。study-list-scroll の md:min-h-56 と同じ）と、絞り込みと一覧の間（gap-2） */
const LIST_MIN_PX = 224;
const TOP_GAP_PX = 8;

const listKey =(filter: StudyFilter) => ["studies", filterToSearchParams(filter).toString()] as const;

const MODALITY_COLOR: Record<ModalityGroup, string> = {
  CT: "bg-mod-ct",
  MR: "bg-mod-mr",
  "CR/DX": "bg-mod-crdx",
  US: "bg-mod-us",
  ES: "bg-mod-es",
  MG: "bg-mod-mg",
  DOC: "bg-mod-doc",
  SR: "bg-mod-sr",
};

function ModalityTag({ modality }: { modality: string }) {
  const group = modalityGroupOf(modality);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span aria-hidden className={cn("inline-block size-2 rounded-full", group ? MODALITY_COLOR[group] : "bg-label")} />
      {modality}
    </span>
  );
}

/** 見出しの名前に件数を添える（`CT (6)`）。件数が無い（許可されていない項目）ときは名前だけ */
const withCount = (label: string, n: number | undefined, atLeast = false) =>
  n === undefined ? label : `${label} (${n}${atLeast ? " 以上" : ""})`;

/** 1 つの並び（タブ・ボタン）。押せる大きさは 28px の高さ（24px 以上） */
function Segmented({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // 見える名前は付けない（幅のため）。読み上げにはグループの名前、マウスには title で知らせる
    <div className="inline-flex overflow-hidden rounded-md border border-border" role="group" aria-label={label} title={label}>
      {children}
    </div>
  );
}

function Chip({ pressed, onClick, children, testId }: { pressed: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center whitespace-nowrap border-r border-border px-1.5 text-sm transition-colors last:border-r-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        pressed ? "bg-primary text-primary-foreground active:bg-primary-active" : "text-foreground hover:bg-hover active:bg-pressed",
      )}
    >
      {children}
    </button>
  );
}

function FilterBar({
  filter,
  facets,
  onChange,
  trailing,
}: {
  filter: StudyFilter;
  facets: StudyFacets | undefined;
  onChange: (f: StudyFilter) => void;
  trailing?: React.ReactNode;
}) {
  const [text, setText] = useState(filter.q ?? "");
  // 使うことの少ない条件（期間の指定）は「詳しく」の中。期間で絞っているときは最初から開く
  const [more, setMore] = useState(filter.date === "range");
  const moreId = useId();
  // 打つたびに要求を送らない（止まってから 300 ミリ秒）
  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = text.trim() || undefined;
      if (q !== filter.q) onChange({ ...filter, q });
    }, 300);
    return () => window.clearTimeout(t);
  }, [text, filter, onChange]);

  return (
    <div className="shrink-0 space-y-1.5" data-testid="study-filters">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Segmented label="検査日">
          {FACET_DATES.map((d) => (
            <Chip key={d} pressed={filter.date === d} onClick={() => onChange({ ...filter, date: d })} testId={`date-${d}`}>
              {withCount(DATE_LABELS[d], facets?.date?.[d], facets?.atLeast?.date?.includes(d))}
            </Chip>
          ))}
        </Segmented>
        <Segmented label="モダリティ">
          <Chip pressed={!filter.modality} onClick={() => onChange({ ...filter, modality: undefined })} testId="modality-all">
            {withCount("すべて", facets?.modality?.all, facets?.atLeast?.list)}
          </Chip>
          {MODALITY_GROUPS.map((m) => (
            <Chip key={m} pressed={filter.modality === m} onClick={() => onChange({ ...filter, modality: filter.modality === m ? undefined : m })} testId={`modality-${m}`}>
              <span aria-hidden className={cn("mr-1 inline-block size-2 rounded-full", MODALITY_COLOR[m])} />
              {withCount(m, facets?.modality?.[m], facets?.atLeast?.list)}
            </Chip>
          ))}
        </Segmented>
        <div className="relative w-56 max-w-full">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-label" />
          <Input
            type="search"
            value={text}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(e) => setText(e.target.value)}
            placeholder="患者ID・氏名・受付番号"
            title="患者ID・氏名（漢字・カナ・英字）・受付番号・検査名"
            aria-label="検査の検索"
            className="h-7 pl-8"
            data-testid="study-search"
          />
        </div>
        <button
          type="button"
          aria-expanded={more}
          aria-controls={moreId}
          data-testid="filter-more"
          onClick={() => setMore((v) => !v)}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-sm text-foreground hover:border-label hover:bg-hover active:bg-pressed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {more ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
          詳細条件
        </button>
        {trailing}
      </div>
      {more && (
        <div
          id={moreId}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5"
          role="group"
          aria-label="詳細条件"
          data-testid="filter-more-panel"
        >
          <span className="text-xs text-label">検査日</span>
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            <Chip pressed={filter.date === "range"} onClick={() => onChange({ ...filter, date: "range" })} testId="date-range">
              {DATE_LABELS.range}
            </Chip>
          </div>
          {filter.date === "range" && (
            <span className="flex items-center gap-1">
              <Input
                type="date"
                aria-label="開始日"
                value={filter.from ?? ""}
                onChange={(e) => onChange({ ...filter, from: e.target.value || undefined })}
                className="h-7 w-40"
              />
              <span className="text-label">〜</span>
              <Input
                type="date"
                aria-label="終了日"
                value={filter.to ?? ""}
                onChange={(e) => onChange({ ...filter, to: e.target.value || undefined })}
                className="h-7 w-40"
              />
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** 行を一覧の見える所に入れる。固定の見出し行の下に隠れないよう、見出しの高さを除いた範囲で寄せる（一覧が小さくても揺れない） */
function revealRow(row: HTMLElement) {
  const list = row.closest<HTMLElement>("[data-testid=study-list-scroll]");
  if (!list) return;
  const head = list.querySelector("thead")?.getBoundingClientRect().height ?? 0;
  const box = list.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  const top = box.top + list.clientTop + head;
  const bottom = box.top + list.clientTop + list.clientHeight;
  if (r.top < top) list.scrollTop -= top - r.top;
  else if (r.bottom > bottom) list.scrollTop += r.bottom - bottom;
}

/** 14px の文字の、おおよその幅（px）。全角は 1 字 14px、半角は 0.62 字ぶん（等幅の字と太字を含めて、少し広めに見る） */
function textWidth(text: string | undefined): number {
  let w = 0;
  for (const ch of text ?? "") w += /[⺀-￯]/.test(ch) && !/[｡-ﾟ]/.test(ch) ? 14 : 8.7;
  return Math.ceil(w);
}

/** 列の左右の余白（px-2）と罫線 */
const CELL_PAD = 18;
/** モダリティ・検査の記述の列の最小の幅。一覧がこれより狭いときは、一覧の中で横にスクロールする */
const DESC_MIN = 160;

/**
 * 一覧の列（px。docs/spec.md の 3.1）。患者 ID・生年月日・年齢・性別は切らない（患者 ID の列は、出している行のいちばん長い値に合わせる）。
 * 氏名とかなも、いちばん長い値に合わせ、上限を超える値だけを `…` で切る（全文は title）。
 * モダリティ・検査の記述は残りの幅を取る。氏名の漢字とかなは別の列（かなは漢字の右）
 */
function columnsFor(studies: readonly StudyView[]) {
  const widest = (pick: (s: StudyView) => string | undefined) => Math.max(0, ...studies.map((s) => textWidth(pick(s))));
  const fit = (pick: (s: StudyView) => string | undefined, min: number, max: number) =>
    Math.min(max, Math.max(min, widest(pick) + CELL_PAD));
  return [
    { key: "date", width: 148 },
    // 患者 ID は DICOM の LO（64 字まで）。上限を置かずに値に合わせる（切らない）
    { key: "id", width: Math.max(80, widest((s) => s.patientId) + CELL_PAD) },
    { key: "name", width: fit((s) => s.patientName, 104, 240) },
    { key: "kana", width: fit((s) => s.patientKana, 96, 200) },
    { key: "birth", width: 104 },
    { key: "age", width: 60 },
    { key: "sex", width: 64 },
    { key: "desc", width: undefined },
    { key: "count", width: 100 },
    { key: "viewer", width: 142 },
  ] as const;
}

/**
 * 一覧を読み直しても、見ていた行の位置を保つ（docs/spec.md の 3.1 の自動更新）。スクロールしているときは、見えている先頭の行を
 * 印にし、読み直した後に同じ行が同じ高さに来るように戻す（新しい検査が上に足されても、見ていた行が動かない）。
 * いちばん上にいるときは保たない（新しい検査が上に出て、目に入る）。絞り込みを替えた（listKey が替わった）ときは、印を捨てる
 */
function useScrollAnchor(ref: React.RefObject<HTMLDivElement | null>, studies: readonly StudyView[], listKey: string) {
  const anchor = useRef<{ uid: string; offset: number; key: string } | null>(null);
  const measure = useCallback(() => {
    const box = ref.current;
    anchor.current = null;
    if (!box || box.scrollTop === 0) return;
    const top = box.getBoundingClientRect().top + (box.querySelector("thead")?.getBoundingClientRect().height ?? 0);
    for (const row of box.querySelectorAll<HTMLElement>("tbody > tr[data-study-uid]")) {
      const r = row.getBoundingClientRect();
      if (r.bottom > top && row.dataset.studyUid) {
        anchor.current = { uid: row.dataset.studyUid, offset: r.top - top, key: listKey };
        return;
      }
    }
  }, [ref, listKey]);
  useLayoutEffect(() => {
    const box = ref.current;
    const a = anchor.current;
    // 同じ絞り込みの読み直し（自動更新など）のときだけ戻す
    if (box && a && a.key === listKey) {
      const row = box.querySelector<HTMLElement>(`tbody > tr[data-study-uid="${CSS.escape(a.uid)}"]`);
      const top = box.getBoundingClientRect().top + (box.querySelector("thead")?.getBoundingClientRect().height ?? 0);
      if (row) box.scrollTop += row.getBoundingClientRect().top - top - a.offset;
    }
    measure();
  }, [ref, studies, measure, listKey]);
  return measure;
}

/** 一覧の 1 行の高さ（28px）。14px の文字（行の高さ 20px）に上下 4px */
const CELL = "h-7 px-2 py-0";
/** 値が 1 行に収まらないときは `…` で切る（全文は title）。一覧の行だけ。詳細のパネルでは切らない */
const CUT = "overflow-hidden text-ellipsis whitespace-nowrap";

function StudyRows({
  studies,
  screen,
  selected,
  onSelect,
  onChanged,
  dim = false,
  listKey,
}: {
  /** いまの絞り込み（URL の形）。替わったら、見ていた行の位置を保たない */
  listKey: string;
  studies: StudyView[];
  screen: ScreenInfo;
  selected: string | null;
  /** how: click は詳細をすぐ読む、key（矢印）は少し待ってから読む */
  onSelect: (uid: string | null, how: "click" | "key") => void;
  onChanged: () => void;
  /** 取り直しの待ちの間、古い行を薄くする（docs/spec.md の 2.3） */
  dim?: boolean;
}) {
  // 矢印で動く（ローヴィングの tabindex）：選んだ行、無ければ先頭の行だけが tab の止まり先
  const tabStop = studies.some((s) => s.studyInstanceUid === selected) ? selected : (studies[0]?.studyInstanceUid ?? null);
  const columns = columnsFor(studies);
  const minWidth = columns.reduce((sum, c) => sum + (c.width ?? DESC_MIN), 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollAnchor(scrollRef, studies, listKey);
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      // 行の位置は useScrollAnchor が保つ（ブラウザのスクロールの寄せと二重に動かさない）
      className="min-h-0 flex-1 overflow-auto [overflow-anchor:none] rounded-md border border-border md:min-h-56"
      data-testid="study-list-scroll"
    >
      {/* 取り直しの待ちの細い帯は、一覧の上の縁に重ねる（場所を取らない。画面は覆わない） */}
      {dim && (
        <div className="sticky top-0 z-20 h-0">
          <div className="absolute inset-x-0 top-0">
            <ProgressBar />
          </div>
        </div>
      )}
      <table className="w-full table-fixed border-collapse" style={{ minWidth }} data-testid="study-table">
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} data-col={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-label shadow-[0_1px_0_var(--color-border)]">
          <tr className="border-b border-border">
            <th className={cn("px-2 py-1 font-normal", CUT)}>検査日時</th>
            <th className={cn("px-2 py-1 font-normal", CUT)}>患者ID</th>
            <th className={cn("px-2 py-1 font-normal", CUT)}>氏名</th>
            <th className={cn("px-2 py-1 font-normal", CUT)}>カナ</th>
            <th className={cn("px-2 py-1 font-normal", CUT)}>生年月日</th>
            <th className={cn("px-2 py-1 font-normal", CUT)}>年齢</th>
            <th className={cn("px-2 py-1 font-normal", CUT)}>性別</th>
            <th className={cn("px-2 py-1 font-normal", CUT)}>モダリティ／検査名</th>
            <th className={cn("px-2 py-1 text-right font-normal", CUT)} title="シリーズ数／画像数">
              Se/Im
            </th>
            <th className="px-2 py-1 font-normal">
              <span className="sr-only">ビューア</span>
            </th>
          </tr>
        </thead>
        <tbody className={cn("transition-opacity", dim && "opacity-60")} data-dim={dim || undefined}>
          {studies.map((s, i) => {
            const uid = s.studyInstanceUid ?? "";
            const isOpen = selected !== null && uid === selected;
            const dateTime = `${formatSlashDate(s.studyDate)} ${formatDicomTime(s.studyTime)}`.trim();
            const birthTitle = formatBirthWareki(s.patientBirthDate);
            const desc = [s.modalities?.join("・"), s.studyDescription].filter(Boolean).join(" ");
            return (
              <tr
                  key={uid || `row-${i}`}
                  data-study-uid={uid}
                  aria-selected={isOpen}
                  tabIndex={uid === tabStop ? 0 : -1}
                  // 選んだ行は主の色の薄い地と左の縦線（3px）。hover の地（muted）はそれより薄く、選んだ行には当てない（docs/spec.md の 3.1）
                  data-selected={isOpen || undefined}
                  className={cn(
                    "h-7 cursor-pointer border-b border-border align-middle focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    isOpen ? "bg-selected [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-primary)]" : "hover:bg-muted",
                  )}
                  onClick={(e) => {
                    // ビューアの部品の中の操作は、選ぶ操作にしない。行を選んでも一覧の行は動かない（詳細は下の場所に出る）
                    if ((e.target as HTMLElement).closest("[data-row-control]")) return;
                    onSelect(uid, "click");
                  }}
                  onDoubleClick={(e) => {
                    if ((e.target as HTMLElement).closest("[data-row-control]")) return;
                    openInViewer(uid, s.defaultViewer);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter") {
                      e.preventDefault();
                      openInViewer(uid, s.defaultViewer);
                    } else if (e.key === " ") {
                      e.preventDefault();
                      onSelect(uid, "click");
                    } else if (e.key === "Escape") {
                      onSelect(null, "click");
                    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const next = (e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
                      const nextUid = next?.dataset.studyUid;
                      if (!next || !nextUid) return;
                      next.focus({ preventScroll: true });
                      revealRow(next);
                      onSelect(nextUid, "key");
                    }
                  }}
                >
                  <td className={cn(CELL, CUT)} title={dateTime}>
                    {formatSlashDate(s.studyDate)}
                    <span className="ml-1.5 text-label">{formatDicomTime(s.studyTime)}</span>
                  </td>
                  <td className={cn(CELL, "font-mono whitespace-nowrap")} data-testid="patient-id">
                    {s.patientId}
                  </td>
                  <td className={cn(CELL, CUT)} title={s.patientName}>
                    {s.patientName ? (
                      <span className="font-bold text-value" data-testid="patient-name">
                        {s.patientName}
                      </span>
                    ) : (
                      <span className="text-label">（氏名未登録）</span>
                    )}
                  </td>
                  <td className={cn(CELL, CUT, "text-label")} title={s.patientKana} data-testid="patient-kana">
                    {s.patientKana}
                  </td>
                  <td className={cn(CELL, "whitespace-nowrap tabular-nums")} title={birthTitle || undefined} data-testid="patient-birth">
                    {formatSlashDate(s.patientBirthDate)}
                  </td>
                  <td className={cn(CELL, "whitespace-nowrap tabular-nums")} data-testid="patient-age">
                    {formatAge(s.patientBirthDate, s.studyDate)}
                  </td>
                  <td className={cn(CELL, "whitespace-nowrap")} data-testid="patient-sex">
                    {sexLabel(s.patientSex)}
                  </td>
                  <td className={cn(CELL, CUT)} title={desc}>
                    <span className="mr-2 inline-flex gap-2 align-middle">
                      {s.modalities?.map((m) => <ModalityTag key={m} modality={m} />)}
                    </span>
                    {s.studyDescription && <span className="text-label">{s.studyDescription}</span>}
                  </td>
                  <td className={cn(CELL, CUT, "text-right")}>
                    {s.seriesCount ?? "—"}
                    <span className="text-label"> / </span>
                    {s.instanceCount ?? "—"}
                  </td>
                  <td className={cn(CELL, "text-right")}>
                    {uid && (
                      <ViewerMenu
                        compact
                        studyUid={uid}
                        defaultViewer={s.defaultViewer}
                        rememberedViewer={s.rememberedViewer}
                        viewerVersion={s.viewerVersion}
                        screen={screen}
                        onChanged={onChanged}
                      />
                    )}
                  </td>
                </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * 一覧の自動更新（docs/spec.md の 3.1）。seconds ごとに一覧の版（/api/studies/version。Orthanc の変更の記録の番号）を読み、
 * 版が変わったときだけ一覧を読み直す（変わらなければ検査の検索をしない）。選んだ行・スクロール・開いている詳細はそのまま
 * （詳細は読み直さない。「詳細を開いた」の記録を増やさない）。この読み直しの間は待ちの印を出さない（quiet）。
 * タブを隠している間は読まず、戻ったらすぐ読む。seconds が 0 なら何もしない。
 * 読み直しの要求を出す間は autoRef を true にし、一覧の要求に `refresh=auto` を付けさせる（監査の記録に trigger: "auto" が残る）
 */
function useListRefresh(seconds: number, initialVersion: string | undefined, autoRef: React.RefObject<boolean>) {
  const queryClient = useQueryClient();
  const [quiet, setQuiet] = useState(false);
  // 基準の版。サーバーが一覧を取る前に読んだ版。無ければ、最初に読んだ版を基準にする
  const base = useRef(initialVersion);
  const version = useQuery({
    queryKey: ["studies-version"],
    queryFn: async ({ signal }) => {
      const { version: next } = await getJson<{ version: string }>("/api/studies/version", signal);
      if (base.current === undefined || base.current === next) {
        base.current = next;
        return next;
      }
      setQuiet(true);
      autoRef.current = true;
      try {
        // 開いていない絞り込みの一覧は古い印だけを付け、いま出している一覧を読み直す
        await queryClient.invalidateQueries({ queryKey: ["studies"], refetchType: "none" });
        const done = queryClient.refetchQueries({ queryKey: ["studies"], type: "active" }, { throwOnError: true });
        // 要求を出した後に戻す（同じ時に利用者が絞り込みを替えた要求には付けない）
        autoRef.current = false;
        await done;
        base.current = next;
      } catch {
        // 一覧を読めなかったときは、誤りを一覧の上に出し、版を進めない（次の間隔で読み直す）
      } finally {
        autoRef.current = false;
        setQuiet(false);
      }
      return next;
    },
    enabled: seconds > 0,
    refetchInterval: seconds > 0 ? seconds * 1000 : false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  return { quiet, failed: version.isError };
}

function Browser({
  initialFilter,
  initialData,
  initialDataAt,
  initialVersion,
  screen,
}: {
  initialFilter: StudyFilter;
  initialData: StudyListData;
  /** サーバーの側で一覧を取った時刻（ミリ秒）。古くなった最初の値を新しいものとして使わない */
  initialDataAt: number;
  /** サーバーの側で一覧を取る前に読んだ、一覧の版（自動更新の基準） */
  initialVersion?: string;
  screen: ScreenInfo;
}) {
  const [filter, setFilter] = useState<StudyFilter>(initialFilter);
  const [selected, setSelected] = useState<string | null>(null);
  // 詳細を実際に取る検査。クリックならすぐ、矢印で移るときは止まってから（通り過ぎた行の「詳細を開いた」を記録しない）
  const [loadedUid, setLoadedUid] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const select = useCallback((uid: string | null, how: "click" | "key") => {
    window.clearTimeout(timer.current);
    setSelected(uid);
    if (uid === null || how === "click") setLoadedUid(uid);
    else {
      // 矢印で移る間は、いまの詳細を取った印を外す（A→B→A と戻っても、止まってから取り直す）
      setLoadedUid(null);
      timer.current = window.setTimeout(() => setLoadedUid(uid), DETAIL_DELAY_MS);
    }
  }, []);

  // 狭い画面では、詳細が一覧の上に重なる。開いたら詳細へフォーカスを移し、背後の一覧は操作・読み上げの対象から外し、閉じたら元の行へ戻す
  const narrow = useSyncExternalStore(subscribeNarrow, getNarrow, getServerNarrow);
  const paneRef = useRef<HTMLDivElement>(null);
  const restoreUid = useRef<string | null>(null);

  const split = useSyncExternalStore(subscribeSplit, getSplit, getServerSplit);
  const box = useRef<HTMLElement>(null);
  const topId = useId();
  const queryClient = useQueryClient();
  const initialKey = filterToSearchParams(initialFilter).toString();
  const params = filterToSearchParams(filter).toString();
  const autoRefreshRef = useRef(false);

  const list = useQuery({
    queryKey: listKey(filter),
    queryFn: ({ signal }) => {
      // 自動更新の読み直しには refresh=auto を付ける（監査の記録で、利用者の検索と分けて追えるように）
      const query = new URLSearchParams(params);
      if (autoRefreshRef.current) query.set("refresh", "auto");
      const qs = query.toString();
      return getJson<StudyListData>(`/api/studies${qs ? `?${qs}` : ""}`, signal);
    },
    initialData: params === initialKey ? initialData : undefined,
    initialDataUpdatedAt: initialDataAt,
    placeholderData: (previous) => previous,
  });

  // 絞り込みを頁の URL に写す（頁は読み直さない）
  useEffect(() => {
    const url = params ? `/?${params}` : "/";
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, "", url);
  }, [params]);

  const changed = () => void queryClient.invalidateQueries({ queryKey: ["studies"] });
  const data = list.data;
  const refreshSeconds = screen.refreshSeconds ?? 0;
  const refresh = useListRefresh(refreshSeconds, initialVersion, autoRefreshRef);
  // 取り直しの待ちの印（0.3 秒たってから。docs/spec.md の 2.3）：一覧の上の細い帯・古い行を薄く・件数を「—」。
  // 自動更新の読み直しには出さない（30 秒ごとに一覧がちらつかないように）
  const fetching = list.isFetching && !refresh.quiet;
  const refetching = useDelayedPending(fetching);

  // 削除が終わったことの知らせ（docs/spec.md の 3.5「消した後」）。消すと行も詳細も消えるので、一覧の上に出す。
  // 次の操作（絞り込み・行の選び直し）までか、10 秒で消す
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(t);
  }, [notice]);
  const changeFilter = (f: StudyFilter) => {
    setNotice(null);
    setFilter(f);
  };
  /** 条件をクリア：絞り込みを既定に戻す。検索の欄の打ちかけの字も消すため、絞り込みの部品を作り直す */
  const [filterKey, setFilterKey] = useState(0);
  const clearFilter = () => {
    setFilterKey((k) => k + 1);
    changeFilter(DEFAULT_FILTER);
  };
  const pick = (uid: string | null, how: "click" | "key") => {
    setNotice(null);
    select(uid, how);
  };
  /** 消したあと、フォーカスを移す行の位置（消した行の位置。一覧を読み直したら、その位置の行へ） */
  const focusIndex = useRef<number | null>(null);
  const deleted = (study: StudyView) => {
    focusIndex.current = data?.studies.findIndex((s) => s.studyInstanceUid === study.studyInstanceUid) ?? null;
    setNotice(
      `検査を削除しました（${[study.patientId, formatSlashDate(study.studyDate), study.modalities?.join("・")].filter(Boolean).join("・")}）`,
    );
    select(null, "click");
    changed();
  };
  useEffect(() => {
    if (focusIndex.current === null || list.isFetching || !data) return;
    const i = Math.min(focusIndex.current, data.studies.length - 1);
    focusIndex.current = null;
    if (i < 0) return;
    box.current?.querySelectorAll<HTMLElement>("tbody > tr[data-study-uid]")[i]?.focus({ preventScroll: true });
  }, [data, list.isFetching]);
  const selectedRow = selected ? data?.studies.find((s) => s.studyInstanceUid === selected) : undefined;
  const overlayOpen = narrow && !!selectedRow;
  useEffect(() => {
    if (overlayOpen) paneRef.current?.focus({ preventScroll: true });
  }, [overlayOpen]);
  useEffect(() => {
    if (selectedRow || !restoreUid.current) return;
    const uid = restoreUid.current;
    restoreUid.current = null;
    box.current?.querySelector<HTMLElement>(`tr[data-study-uid="${CSS.escape(uid)}"]`)?.focus({ preventScroll: true });
  }, [selectedRow]);
  // 絞り込みの高さ（折り返しで変わる）を測り、上の場所の最小の高さに使う
  const topRef = useRef<HTMLDivElement>(null);
  const [filtersH, setFiltersH] = useState(0);
  useEffect(() => {
    const el = topRef.current?.firstElementChild;
    if (!el) return;
    const ro = new ResizeObserver(() => setFiltersH(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const closeDetail = () => {
    restoreUid.current = selected;
    select(null, "click");
  };

  return (
    <section ref={box} data-split-root className="relative flex min-h-0 flex-1 flex-col">
      {/* 上の場所は、絞り込みの高さ＋一覧の最小の高さより縮まない。境目を上へ寄せても、一覧が消えず、絞り込みがはみ出さない */}
      <div
        id={topId}
        ref={topRef}
        inert={overlayOpen || undefined}
        className="flex min-h-0 flex-1 flex-col gap-2 md:min-h-(--top-min) md:flex-none md:basis-(--split)"
        style={{ "--split": `${split}%`, "--top-min": `${filtersH + TOP_GAP_PX + LIST_MIN_PX}px` } as React.CSSProperties}
      >
      <FilterBar
        key={filterKey}
        filter={filter}
        facets={data?.facets}
        onChange={changeFilter}
        trailing={
          <div className="flex flex-wrap items-baseline gap-2">
            <h1 className="flex items-baseline gap-1" aria-live="polite" data-fetching={list.isFetching || undefined}>
              {/* 取り直しの待ちの印が出ている間は、件数を「—」にする（古い件数を新しいものに見せない） */}
              <span className="text-lg font-bold text-value" data-testid="study-count">
                {data && !refetching ? `${data.count.count}${data.count.exact ? "" : " 以上"}` : "—"}
              </span>
              <span className="text-label">件</span>
            </h1>
            <PendingText pending={fetching} />
            {refreshSeconds > 0 && (
              <span
                className={cn("inline-flex items-center gap-1 text-xs", refresh.failed ? "text-danger" : "text-label")}
                data-testid="list-refresh"
                data-failed={refresh.failed || undefined}
              >
                <RefreshCw aria-hidden className="size-3.5" />
                {refresh.failed ? "自動更新：接続できません" : `自動更新（${refreshSeconds}秒）`}
              </span>
            )}
            {notice && (
              <p role="status" className="flex items-center gap-1.5 rounded-md border border-success px-2 text-sm text-success" data-testid="list-notice">
                <CheckCircle2 aria-hidden className="size-4" />
                {notice}
              </p>
            )}
          </div>
        }
      />

      {list.isError && (
        <p role="alert" className="text-danger">
          {list.error.message}
        </p>
      )}
      {data && data.studies.length === 0 && (
        <p className="flex items-center gap-3 text-label" data-testid="study-list-empty">
          該当する検査はありません
          <Button type="button" size="sm" variant="outline" onClick={clearFilter}>
            条件をクリア
          </Button>
        </p>
      )}
      {data && data.studies.length > 0 && (
        <StudyRows
          studies={data.studies}
          // 前の絞り込みの行を出している間（placeholder）は、別の印にする（新しい絞り込みの行で、見ていた行の位置を戻さない）
          listKey={list.isPlaceholderData ? "placeholder" : `list:${params}`}
          screen={screen}
          selected={selected}
          onSelect={pick}
          onChanged={changed}
          dim={refetching}
        />
      )}
      </div>

      {/* 境目：上下に動かせる（矢印のキー・Home・End・ドラッグ）。狭い画面では上下に分けない */}
      {/* 動かせる境目は WAI-ARIA の focusable separator（widget）。jsx-a11y はこの形を知らないので、2つの規則だけ外す */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="一覧と詳細の境界"
        aria-controls={topId}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={split}
        aria-valuetext={`一覧 ${split}%`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        data-testid="split-handle"
        className="group hidden h-3 shrink-0 cursor-row-resize touch-none items-center justify-center focus-visible:outline-none md:flex"
        onKeyDown={(e) => {
          const next = splitAfterKey(split, e.key);
          if (next === null) return;
          e.preventDefault();
          setSplit(next);
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!e.currentTarget.hasPointerCapture(e.pointerId) || !box.current) return;
          const rect = box.current.getBoundingClientRect();
          if (rect.height > 0) setSplit(((e.clientY - rect.top) / rect.height) * 100);
        }}
      >
        <span aria-hidden className="h-1 w-16 rounded-full bg-border group-hover:bg-label group-focus-visible:bg-ring" />
      </div>

      {/* 下：選んだ検査の詳細。狭い画面では、選んだときだけ一覧の上に重ねて出す。詳細の中の Escape で閉じる（メニューが開いているときはメニューが先） */}
      {/* 枠そのものは操作の部品ではない（フォーカスを受けて Escape を拾うだけ）ので、この規則だけ外す */}
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        ref={paneRef}
        tabIndex={-1}
        data-testid="detail-pane"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !selectedRow || e.defaultPrevented) return;
          if (e.currentTarget.querySelector("[role=menu]")) return;
          closeDetail();
        }}
        className={cn(
          "bg-surface focus-visible:outline-none max-md:absolute max-md:inset-0 max-md:z-30 max-md:overflow-auto md:min-h-0 md:flex-1 md:overflow-auto md:rounded-md md:border md:border-border",
          !selectedRow && "max-md:hidden",
        )}
      >
        {selectedRow ? (
          <>
            <button
              type="button"
              aria-label="詳細を閉じる"
              onClick={closeDetail}
              className="sticky top-0 float-right z-10 m-2 rounded p-1 text-label hover:bg-hover active:bg-pressed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:hidden"
            >
              <X aria-hidden className="size-5" />
            </button>
            <StudyDetailPanel
              key={selectedRow.studyInstanceUid}
              row={selectedRow}
              screen={screen}
              onChanged={changed}
              onDeleted={deleted}
              fetchEnabled={loadedUid === selected}
            />
          </>
        ) : (
          <p className="p-4 text-label" data-testid="study-detail-empty">
            検査を選択してください
          </p>
        )}
      </div>
    </section>
  );
}

export function StudyBrowser(props: {
  initialFilter: StudyFilter;
  initialData: StudyListData;
  initialDataAt: number;
  initialVersion?: string;
  screen: ScreenInfo;
}) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Browser {...props} />
    </QueryClientProvider>
  );
}
