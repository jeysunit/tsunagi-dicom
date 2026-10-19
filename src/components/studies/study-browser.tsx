"use client";

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Search, Siren, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Input } from "@/components/ui/input";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { StudyDetailPanel } from "@/components/studies/study-detail";
import { Thumbnail } from "@/components/studies/thumbnail";
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
import { formatBirthLine, formatDicomTime, formatSlashDate } from "@/lib/format/japanese-date";
import { MODALITY_GROUPS, modalityGroupOf, type ModalityGroup } from "@/lib/modalities";
import {
  DATE_LABELS,
  DATE_PRESETS,
  filterToSearchParams,
  MAX_QUERY_LENGTH,
  STATUS_FILTERS,
  STATUS_LABELS,
  type StudyFilter,
} from "@/lib/study-filter";
import { cn } from "@/lib/utils";

// 検査の一覧（docs/spec.md の 3.1）。すぐ絞れる見出し・読みやすい一覧（14px）・詳細のパネル・ビューアの選び分け。
// 上下に分ける：上＝絞り込みと一覧（この中だけでスクロール）、下＝選んだ検査の詳細。頁全体はスクロールさせない。
// データは TanStack Query で画面の API（/api/studies）から取る。最初の描画はサーバーの側で取った値を使う。
// 絞り込みの値は頁の URL に持つ（開き直し・戻るでも同じ絞り込み）。

export interface StudyListData {
  count: { count: number; exact: boolean };
  studies: StudyView[];
}

/** 矢印のキーで行を移したあと、詳細を読みに行くまでの待ち（ミリ秒）。通り過ぎた行を読まない */
const DETAIL_DELAY_MS = 300;
/** 一覧の最小の高さ（見出しと 3 行ほど。study-list-scroll の md:min-h-56 と同じ）と、絞り込みと一覧の間（gap-3） */
const LIST_MIN_PX = 224;
const TOP_GAP_PX = 12;

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

function Chip({ pressed, onClick, children, testId }: { pressed: boolean; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-0.5 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        pressed ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function FilterBar({ filter, onChange, trailing }: { filter: StudyFilter; onChange: (f: StudyFilter) => void; trailing?: React.ReactNode }) {
  const [text, setText] = useState(filter.q ?? "");
  // 打つたびに要求を送らない（止まってから 300 ミリ秒）
  useEffect(() => {
    const t = window.setTimeout(() => {
      const q = text.trim() || undefined;
      if (q !== filter.q) onChange({ ...filter, q });
    }, 300);
    return () => window.clearTimeout(t);
  }, [text, filter, onChange]);

  return (
    <div className="shrink-0 space-y-2" data-testid="study-filters">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        <div className="relative w-full max-w-xl">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-label" />
          <Input
            type="search"
            value={text}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(e) => setText(e.target.value)}
            placeholder="患者 ID・氏名（漢字・かな・英字）・受付番号・検査の記述"
            aria-label="横断の検索"
            className="h-9 pl-8"
            data-testid="study-search"
          />
        </div>
        {trailing}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="検査日">
        <span className="w-20 text-xs text-label">検査日</span>
        {DATE_PRESETS.map((d) => (
          <Chip key={d} pressed={filter.date === d} onClick={() => onChange({ ...filter, date: d })} testId={`date-${d}`}>
            {DATE_LABELS[d]}
          </Chip>
        ))}
        {filter.date === "range" && (
          <span className="flex items-center gap-1">
            <Input
              type="date"
              aria-label="期間の始まり"
              value={filter.from ?? ""}
              onChange={(e) => onChange({ ...filter, from: e.target.value || undefined })}
              className="h-8 w-40"
            />
            <span className="text-label">〜</span>
            <Input
              type="date"
              aria-label="期間の終わり"
              value={filter.to ?? ""}
              onChange={(e) => onChange({ ...filter, to: e.target.value || undefined })}
              className="h-8 w-40"
            />
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="モダリティ">
        <span className="w-20 text-xs text-label">モダリティ</span>
        <Chip pressed={!filter.modality} onClick={() => onChange({ ...filter, modality: undefined })} testId="modality-all">
          すべて
        </Chip>
        {MODALITY_GROUPS.map((m) => (
          <Chip key={m} pressed={filter.modality === m} onClick={() => onChange({ ...filter, modality: filter.modality === m ? undefined : m })} testId={`modality-${m}`}>
            <span aria-hidden className={cn("mr-1.5 inline-block size-2 rounded-full", MODALITY_COLOR[m])} />
            {m}
          </Chip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="状態">
        <span className="w-20 text-xs text-label">状態</span>
        <Chip pressed={!filter.status} onClick={() => onChange({ ...filter, status: undefined })} testId="status-all">
          すべて
        </Chip>
        {STATUS_FILTERS.map((s) => (
          <Chip key={s} pressed={filter.status === s} onClick={() => onChange({ ...filter, status: filter.status === s ? undefined : s })} testId={`status-${s}`}>
            {STATUS_LABELS[s]}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function StateBadges({ s }: { s: StudyView }) {
  return (
    <span className="flex flex-wrap items-center gap-1 text-xs">
      {s.urgent && (
        <span className="inline-flex items-center gap-0.5 rounded bg-danger px-1.5 py-0.5 font-bold text-background" data-testid="badge-urgent">
          <Siren aria-hidden className="size-3" />
          緊急
        </span>
      )}
      {typeof s.inspected === "boolean" && (
        <span className={cn("rounded border border-border px-1.5 py-0.5", s.inspected ? "text-foreground" : "text-label")}>
          {s.inspected ? "検像済" : "未検像"}
        </span>
      )}
      {typeof s.read === "boolean" && (
        <span className={cn("rounded border border-border px-1.5 py-0.5", s.read ? "text-foreground" : "text-label")}>
          {s.read ? "既読" : "未読"}
        </span>
      )}
      {s.bookmarked && <Bookmark aria-label="ブックマーク" className="size-3.5 fill-current text-link" />}
    </span>
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

function StudyRows({
  studies,
  screen,
  selected,
  onSelect,
  onChanged,
}: {
  studies: StudyView[];
  screen: ScreenInfo;
  selected: string | null;
  /** how: click は詳細をすぐ読む、key（矢印）は少し待ってから読む */
  onSelect: (uid: string | null, how: "click" | "key") => void;
  onChanged: () => void;
}) {
  // 矢印で動く（ローヴィングの tabindex）：選んだ行、無ければ先頭の行だけが tab の止まり先
  const tabStop = studies.some((s) => s.studyInstanceUid === selected) ? selected : (studies[0]?.studyInstanceUid ?? null);
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border md:min-h-56" data-testid="study-list-scroll">
      <table className="w-full border-collapse" data-testid="study-table">
        <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-label shadow-[0_1px_0_var(--color-border)]">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-normal">状態</th>
            <th className="px-3 py-2 font-normal">
              <span className="sr-only">サムネイル</span>
            </th>
            <th className="px-3 py-2 font-normal">検査日時</th>
            <th className="px-3 py-2 font-normal">患者 ID</th>
            <th className="px-3 py-2 font-normal">氏名</th>
            <th className="px-3 py-2 font-normal">生年月日</th>
            <th className="px-3 py-2 font-normal">モダリティ・検査の記述</th>
            <th className="px-3 py-2 text-right font-normal">シリーズ・画像</th>
            <th className="px-3 py-2 font-normal">
              <span className="sr-only">ビューア</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {studies.map((s, i) => {
            const uid = s.studyInstanceUid ?? "";
            const isOpen = selected !== null && uid === selected;
            return (
              <tr
                  key={uid || `row-${i}`}
                  data-study-uid={uid}
                  aria-selected={isOpen}
                  tabIndex={uid === tabStop ? 0 : -1}
                  className={cn(
                    "cursor-pointer border-b border-border align-top hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    isOpen && "bg-muted",
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
                  <td className="px-3 py-2.5">
                    <StateBadges s={s} />
                  </td>
                  <td className="px-3 py-2">{uid && <Thumbnail studyUid={uid} />}</td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {formatSlashDate(s.studyDate)}
                    <span className="ml-1.5 text-label">{formatDicomTime(s.studyTime)}</span>
                  </td>
                  <td className="px-3 py-2.5 font-mono">{s.patientId}</td>
                  <td className="px-3 py-2.5">
                    {s.patientName ? (
                      <span className="block font-bold text-value" data-testid="patient-name">
                        {s.patientName}
                      </span>
                    ) : (
                      <span className="block text-label">（氏名なし）</span>
                    )}
                    {s.patientKana && <span className="block text-xs text-label">{s.patientKana}</span>}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">{formatBirthLine(s.patientBirthDate, s.patientSex, s.studyDate)}</td>
                  <td className="px-3 py-2.5">
                    <span className="flex flex-wrap gap-2">
                      {s.modalities?.map((m) => <ModalityTag key={m} modality={m} />)}
                    </span>
                    {s.studyDescription && <span className="block text-xs text-label">{s.studyDescription}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right whitespace-nowrap">
                    {s.seriesCount ?? "—"}
                    <span className="text-label"> / </span>
                    {s.instanceCount ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {uid && (
                      <ViewerMenu
                        studyUid={uid}
                        defaultViewer={s.defaultViewer}
                        rememberedViewer={s.rememberedViewer}
                        stateVersion={s.stateVersion}
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

function Browser({
  initialFilter,
  initialData,
  initialDataAt,
  screen,
}: {
  initialFilter: StudyFilter;
  initialData: StudyListData;
  /** サーバーの側で一覧を取った時刻（ミリ秒）。古くなった最初の値を新しいものとして使わない */
  initialDataAt: number;
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

  const list = useQuery({
    queryKey: listKey(filter),
    queryFn: ({ signal }) => getJson<StudyListData>(`/api/studies${params ? `?${params}` : ""}`, signal),
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
        className="flex min-h-0 flex-1 flex-col gap-3 md:min-h-(--top-min) md:flex-none md:basis-(--split)"
        style={{ "--split": `${split}%`, "--top-min": `${filtersH + TOP_GAP_PX + LIST_MIN_PX}px` } as React.CSSProperties}
      >
      <FilterBar
        filter={filter}
        onChange={setFilter}
        trailing={
          <div className="flex items-baseline gap-2" aria-live="polite">
            <h1 className="flex items-baseline gap-2">
              <span className="text-label">検査</span>
              <span className="text-lg font-bold text-value" data-testid="study-count">
                {data ? `${data.count.count}${data.count.exact ? "" : " 以上"}` : "—"}
              </span>
              <span className="text-label">件</span>
            </h1>
            {list.isFetching && <span className="text-xs text-label">読んでいる</span>}
          </div>
        }
      />

      {list.isError && (
        <p role="alert" className="text-danger">
          {list.error.message}
        </p>
      )}
      {data && data.studies.length === 0 && <p className="text-label">合う検査が無い</p>}
      {data && data.studies.length > 0 && (
        <StudyRows studies={data.studies} screen={screen} selected={selected} onSelect={select} onChanged={changed} />
      )}
      </div>

      {/* 境目：上下に動かせる（矢印のキー・Home・End・ドラッグ）。狭い画面では上下に分けない */}
      {/* 動かせる境目は WAI-ARIA の focusable separator（widget）。jsx-a11y はこの形を知らないので、2つの規則だけ外す */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="一覧と詳細の境目"
        aria-controls={topId}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={split}
        aria-valuetext={`一覧が ${split}%`}
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
              className="sticky top-0 float-right z-10 m-2 rounded p-1 text-label hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none md:hidden"
            >
              <X aria-hidden className="size-5" />
            </button>
            <StudyDetailPanel
              key={selectedRow.studyInstanceUid}
              row={selectedRow}
              screen={screen}
              onChanged={changed}
              fetchEnabled={loadedUid === selected}
            />
          </>
        ) : (
          <p className="p-4 text-label" data-testid="study-detail-empty">
            一覧の行を選ぶと、検査の詳細をここに出す。矢印の上下で行を移し、Enter かダブルクリックでビューアを開く。
          </p>
        )}
      </div>
    </section>
  );
}

export function StudyBrowser(props: { initialFilter: StudyFilter; initialData: StudyListData; initialDataAt: number; screen: ScreenInfo }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Browser {...props} />
    </QueryClientProvider>
  );
}
