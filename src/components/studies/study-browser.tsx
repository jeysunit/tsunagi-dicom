"use client";

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bookmark, Search, Siren } from "lucide-react";
import { Fragment, useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { detailKey, fetchDetail, StudyDetailPanel } from "@/components/studies/study-detail";
import { Thumbnail } from "@/components/studies/thumbnail";
import { openInViewer, ViewerMenu } from "@/components/studies/viewer-menu";
import { getJson } from "@/lib/client/api";
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
// データは TanStack Query で画面の API（/api/studies）から取る。最初の描画はサーバーの側で取った値を使う。
// 絞り込みの値は頁の URL に持つ（開き直し・戻るでも同じ絞り込み）。

export interface StudyListData {
  count: { count: number; exact: boolean };
  studies: StudyView[];
}

const listKey = (filter: StudyFilter) => ["studies", filterToSearchParams(filter).toString()] as const;

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
        "rounded-full border px-3 py-1 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        pressed ? "border-primary bg-primary text-primary-foreground" : "border-border text-foreground hover:bg-muted",
      )}
    >
      {children}
    </button>
  );
}

function FilterBar({ filter, onChange }: { filter: StudyFilter; onChange: (f: StudyFilter) => void }) {
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
    <div className="space-y-3" data-testid="study-filters">
      <div className="relative max-w-xl">
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
  onSelect: (uid: string | null) => void;
  onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const COLS = 9;
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse" data-testid="study-table">
        <thead className="bg-surface text-left text-xs text-label">
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
              <Fragment key={uid || `row-${i}`}>
                <tr
                  data-study-uid={uid}
                  aria-selected={isOpen}
                  tabIndex={0}
                  className={cn("cursor-pointer border-b border-border align-top hover:bg-muted", isOpen && "bg-muted")}
                  onMouseEnter={() => uid && void queryClient.prefetchQuery({ queryKey: detailKey(uid), queryFn: () => fetchDetail(uid) })}
                  onClick={(e) => {
                    // ビューアの部品の中の操作と、ダブルクリックの2回目は、詳細の開け閉めにしない
                    if ((e.target as HTMLElement).closest("[data-row-control]") || e.detail > 1) return;
                    onSelect(isOpen ? null : uid);
                  }}
                  onDoubleClick={(e) => {
                    if ((e.target as HTMLElement).closest("[data-row-control]")) return;
                    openInViewer(uid, s.defaultViewer);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(isOpen ? null : uid);
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
                        screen={screen}
                        onChanged={onChanged}
                      />
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr>
                    <td colSpan={COLS} className="p-0">
                      <StudyDetailPanel row={s} screen={screen} onChanged={onChanged} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Browser({ initialFilter, initialData, screen }: { initialFilter: StudyFilter; initialData: StudyListData; screen: ScreenInfo }) {
  const [filter, setFilter] = useState<StudyFilter>(initialFilter);
  const [selected, setSelected] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const initialKey = filterToSearchParams(initialFilter).toString();
  const params = filterToSearchParams(filter).toString();

  const list = useQuery({
    queryKey: listKey(filter),
    queryFn: ({ signal }) => getJson<StudyListData>(`/api/studies${params ? `?${params}` : ""}`, signal),
    initialData: params === initialKey ? initialData : undefined,
    placeholderData: (previous) => previous,
  });

  // 絞り込みを頁の URL に写す（頁は読み直さない）
  useEffect(() => {
    const url = params ? `/?${params}` : "/";
    if (`${window.location.pathname}${window.location.search}` !== url) window.history.replaceState(null, "", url);
  }, [params]);

  const changed = () => void queryClient.invalidateQueries({ queryKey: ["studies"] });
  const data = list.data;

  return (
    <section className="space-y-5">
      <FilterBar filter={filter} onChange={setFilter} />

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

      {list.isError && (
        <p role="alert" className="text-danger">
          {list.error.message}
        </p>
      )}
      {data && data.studies.length === 0 && <p className="text-label">合う検査が無い</p>}
      {data && data.studies.length > 0 && (
        <StudyRows studies={data.studies} screen={screen} selected={selected} onSelect={setSelected} onChanged={changed} />
      )}
    </section>
  );
}

export function StudyBrowser(props: { initialFilter: StudyFilter; initialData: StudyListData; screen: ScreenInfo }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Browser {...props} />
    </QueryClientProvider>
  );
}
