"use client";

import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Inbox, RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Button, pressFeedback, pressInset } from "@/components/ui/button";
import { CountRow } from "@/components/ui/count-row";
import { Input } from "@/components/ui/input";
import { ModalityMark } from "@/components/ui/modality-mark";
import { CellMain, isRowControl, SortableHead, Table, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { PendingText, ProgressBar, useDelayedPending } from "@/components/ui/pending";
import { Notice } from "@/components/ui/notice";
import { Select } from "@/components/ui/select";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { StudyDetailPanel } from "@/components/studies/study-detail";
import { openInViewer, ViewerMenu } from "@/components/studies/viewer-menu";
import { STUDY_LIMIT } from "@/lib/backend/types";
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
import { SPLIT_MIN_BODY_REM, useNarrowerThan } from "@/lib/client/narrow";
import type { StudyView } from "@/lib/fields";
import { formatAge, formatBirthWareki, formatDicomTime, formatSlashDate, sexLabel } from "@/lib/format/japanese-date";
import { DETAIL_GROUPS, LIST_GROUPS, toggleGroup, type ModalityGroup } from "@/lib/modalities";
import {
  advancedCount,
  DATE_LABELS,
  DEFAULT_FILTER,
  FACET_DATES,
  fieldValue,
  filterToSearchParams,
  MAX_FIELD_LENGTH,
  MAX_QUERY_LENGTH,
  PATIENT_SEX,
  type PatientSex,
  type StudyFacets,
  type StudyFilter,
} from "@/lib/study-filter";
import { DEFAULT_SORT, isDefaultSort, nextSort, sortStudies, type SortKey, type StudySort } from "@/lib/study-sort";
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
/** 一覧の中でキーを押した後、自動更新の行の差し込みを待つ時間（ミリ秒。docs/spec.md の 3.1） */
const KEY_HOLD_MS = 3_000;

const listKey =(filter: StudyFilter) => ["studies", filterToSearchParams(filter).toString()] as const;

/** 絞り込みの見出しのモダリティの色の線（一覧の印 `.mod` と同じ左の線の形。丸の点は使わない） */
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

/** 見出しの名前に件数を添える（`CT (6)`）。件数が無い（許可されていない項目）ときは名前だけ */
const withCount = (label: string, n: number | undefined, atLeast = false) =>
  n === undefined ? label : `${label} (${n}${atLeast ? " 以上" : ""})`;

/** 1 つの並び（タブ・ボタン）。押せる大きさは 28px の高さ（24px 以上） */
function Segmented({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // 見える名前は付けない（幅のため）。読み上げにはグループの名前、マウスには title で知らせる
    <div className="inline-flex overflow-hidden rounded-md border border-border-input" role="group" aria-label={label} title={label}>
      {children}
    </div>
  );
}

/** 件数が 0 の見出しは薄く出す（押せるままにする。押すと 0 件になる、と分かる。docs/spec.md の 3.1） */
const isZero = (n: number | undefined) => n === 0;

function Chip({
  pressed,
  onClick,
  children,
  testId,
  dim = false,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
  dim?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center whitespace-nowrap border-r border-border px-1.5 text-sm last:border-r-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        pressInset,
        pressed
          ? "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active"
          : cn("bg-background hover:bg-hover active:bg-pressed", dim ? "text-label" : "text-foreground"),
      )}
      data-dim={dim || undefined}
    >
      {children}
    </button>
  );
}

/** 詳細条件の文字の欄で、打っても受けない字（QIDO-RS の値で特別の意味を持つ字。study-filter.ts の fieldValue） */
const FIELD_STRIP = /[*?\\,]/g;

/** 詳細条件の文字の欄（受付番号・検査名） */
const TEXT_FIELDS = ["accession", "desc"] as const;
type TextField = (typeof TEXT_FIELDS)[number];

/** 詳細条件の文字の欄。打った字は絞り込みの部品（FilterBar）が持つ（「詳細条件」を閉じても、打ちかけの字を失わない） */
function FieldText({
  label,
  value,
  onText,
  testId,
  className,
}: {
  label: string;
  value: string;
  onText: (text: string) => void;
  testId: string;
  className?: string;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="shrink-0 text-xs text-label">{label}</span>
      <Input
        value={value}
        maxLength={MAX_FIELD_LENGTH}
        onChange={(e) => onText(e.target.value.replace(FIELD_STRIP, ""))}
        className={cn("h-7", className)}
        data-testid={testId}
      />
    </label>
  );
}

function FilterBar({
  filter,
  facets,
  onChange,
  filtered,
  onClear,
}: {
  filter: StudyFilter;
  facets: StudyFacets | undefined;
  onChange: (f: StudyFilter) => void;
  /** 絞り込みが既定のままでない（戻す先がある） */
  filtered: boolean;
  onClear: () => void;
}) {
  const [text, setText] = useState(filter.q ?? "");
  // 使うことの少ない条件（期間指定・生年月日・性別・受付番号・検査名）は「詳細条件」の中。どれかで絞っているときは最初から開く
  // 一覧の上に出さないモダリティ（DOC・SR）も詳細条件の数に入れる（閉じていても、絞っていることが分かるように）
  const conditions = advancedCount(filter) + (filter.date === "range" ? 1 : 0) + DETAIL_GROUPS.filter((g) => filter.modalities?.includes(g)).length;
  const [more, setMore] = useState(conditions > 0);
  /** モダリティの見出し 1 つ。押すと、その群を足す・外す（複数選べる。どれかに合う検査を出す。全部外すと「すべて」） */
  const modalityChip = (m: ModalityGroup) => (
    <Chip
      key={m}
      pressed={!!filter.modalities?.includes(m)}
      onClick={() => onChange({ ...filter, modalities: toggleGroup(filter.modalities, m) })}
      testId={`modality-${m}`}
      dim={isZero(facets?.modality?.[m])}
    >
      <span aria-hidden className={cn("mr-1 inline-block h-3.5 w-1", MODALITY_COLOR[m])} />
      {withCount(m, facets?.modality?.[m], facets?.atLeast?.list)}
    </Chip>
  );
  const moreId = useId();
  const birthId = useId();
  // 詳細条件の文字の欄の字もここに持つ（300 ミリ秒の内に「詳細条件」を閉じても失わない）
  const [fields, setFields] = useState<Record<TextField, string>>({
    accession: filter.accession ?? "",
    desc: filter.desc ?? "",
  });
  // 打つたびに要求を送らない（横断の検索と詳細条件の文字の欄の、どれかを打ち止めてから 300 ミリ秒。待ちは1本にまとめる）
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = {
        q: text.trim() || undefined,
        ...(Object.fromEntries(TEXT_FIELDS.map((k) => [k, fieldValue(fields[k])])) as Record<TextField, string | undefined>),
      };
      if ((["q", ...TEXT_FIELDS] as const).some((k) => next[k] !== filter[k])) onChange({ ...filter, ...next });
    }, 300);
    return () => window.clearTimeout(t);
  }, [text, fields, filter, onChange]);
  const fieldText = (key: TextField, label: string, className: string) => (
    <FieldText
      label={label}
      value={fields[key]}
      onText={(v) => setFields((f) => ({ ...f, [key]: v }))}
      testId={`filter-${key}`}
      className={className}
    />
  );

  return (
    // 検査日・検索・詳細条件・モダリティは、muted-strong の地の 1 つの帯に収める（docs/design-system/components.md の「検索の帯」）
    <div className="shrink-0 space-y-1.5 rounded-md bg-muted-strong px-3 py-2" data-testid="study-filters">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Segmented label="検査日">
          {FACET_DATES.map((d) => (
            <Chip key={d} pressed={filter.date === d} onClick={() => onChange({ ...filter, date: d })} testId={`date-${d}`} dim={isZero(facets?.date?.[d])}>
              {withCount(DATE_LABELS[d], facets?.date?.[d], facets?.atLeast?.date?.includes(d))}
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
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-md border border-border-input bg-background px-2 text-sm text-foreground shadow-xs hover:border-label hover:bg-hover active:bg-pressed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            pressFeedback,
          )}
        >
          {more ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />}
          詳細条件
          {/* 閉じていても、詳細条件で絞っていることが分かるように数を添える */}
          {conditions > 0 && <span data-testid="filter-more-count">（{conditions}）</span>}
        </button>
        {/* モダリティは、検索と詳細条件の後に置く。本文が狭いとき（左のナビを開いた 1280px）、検査日・検索・詳細条件が 1 段、モダリティが 1 段の 2 段に収まる */}
        <Segmented label="モダリティ">
          <Chip pressed={!filter.modalities?.length} onClick={() => onChange({ ...filter, modalities: undefined })} testId="modality-all" dim={isZero(facets?.modality?.all)}>
            {withCount("すべて", facets?.modality?.all, facets?.atLeast?.list)}
          </Chip>
          {LIST_GROUPS.map(modalityChip)}
        </Segmented>
        {/* 条件をクリア：帯の右に、いつも置く（位置を動かさない）。絞っていないときは薄く、押せない */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-7 bg-background"
          disabled={!(filtered || text !== "" || TEXT_FIELDS.some((k) => fields[k] !== ""))}
          data-testid="filter-clear"
          onClick={onClear}
        >
          条件をクリア
        </Button>
      </div>
      {more && (
        <div
          id={moreId}
          className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md border border-border bg-surface px-3 py-1.5"
          role="group"
          aria-label="詳細条件"
          data-testid="filter-more-panel"
        >
          <span className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-label">検査日</span>
          <div className="inline-flex overflow-hidden rounded-md border border-border-input">
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
          </span>
          {/* 生年月日・性別・受付番号・検査名は Orthanc の検索（QIDO-RS）の条件にする（docs/spec.md の 3.1）。どれも一覧の列に見える */}
          <span className="flex items-center gap-1.5">
            <label htmlFor={birthId} className="shrink-0 text-xs text-label">
              生年月日
            </label>
            <Input
              id={birthId}
              type="date"
              value={filter.birth ?? ""}
              onChange={(e) => onChange({ ...filter, birth: e.target.value || undefined })}
              className="h-7 w-40"
              data-testid="filter-birth"
            />
          </span>
          <label className="flex items-center gap-1.5">
            <span className="shrink-0 text-xs text-label">性別</span>
            <Select
              size="sm"
              value={filter.sex ?? ""}
              onChange={(e) => onChange({ ...filter, sex: (PATIENT_SEX as readonly string[]).includes(e.target.value) ? (e.target.value as PatientSex) : undefined })}
              data-testid="filter-sex"
            >
              <option value="">すべて</option>
              {PATIENT_SEX.map((s) => (
                <option key={s} value={s}>
                  {sexLabel(s)}
                </option>
              ))}
            </Select>
          </label>
          {/* 一覧の上のモダリティの見出しに無い群（文書・レポート）。上の見出しと同じ選びに足される */}
          <span className="flex items-center gap-1.5">
            <span className="shrink-0 text-xs text-label">モダリティ</span>
            <Segmented label="モダリティ（文書・レポート）">{DETAIL_GROUPS.map(modalityChip)}</Segmented>
          </span>
          {fieldText("accession", "受付番号", "w-32")}
          {fieldText("desc", "検査名", "w-40")}
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
/** 詰めた形（詳細を開いている間）の、同じ列の最小の幅 */
const DESC_MIN_COMPACT = 64;
/** 詰めた形の日時の列（12px の「2026/10/25」が切れない幅） */
const COMPACT_DATE = 84;

/**
 * 一覧の列（px。docs/spec.md の 3.1）。患者 ID・生年月日・年齢・性別は切らない（患者 ID の列は、出している行のいちばん長い値に合わせる）。
 * 氏名とかなも、いちばん長い値に合わせ、上限を超える値だけを `…` で切る（全文は title）。
 * モダリティ・検査の記述は残りの幅を取る。氏名の漢字とかなは別の列（かなは漢字の右）
 */
function columnsFor(studies: readonly StudyView[], showAccession: boolean, compact: boolean) {
  const widest = (pick: (s: StudyView) => string | undefined) => Math.max(0, ...studies.map((s) => textWidth(pick(s))));
  const fit = (pick: (s: StudyView) => string | undefined, min: number, max: number) =>
    Math.min(max, Math.max(min, widest(pick) + CELL_PAD));
  const all: readonly { readonly key: string; readonly width: number | undefined }[] = [
    { key: "date", width: 148 },
    // 患者 ID は DICOM の LO（64 字まで）。上限を置かずに値に合わせる（切らない）
    { key: "id", width: Math.max(80, widest((s) => s.patientId) + CELL_PAD) },
    // 受付番号（2026-10-21。詳細条件で絞れる項目を列に見せる）。SH（16 字まで）なので値に合わせ、上限を超える値だけを切る。
    // 役割の許可の一覧に無い（行に項目が無い）ときは、列ごと出さない
    ...(showAccession ? [{ key: "accession", width: fit((s) => s.accessionNumber, 88, 160) }] : []),
    { key: "name", width: fit((s) => s.patientName, 104, 240) },
    { key: "kana", width: fit((s) => s.patientKana, 96, 200) },
    { key: "birth", width: 104 },
    { key: "age", width: 60 },
    { key: "sex", width: 64 },
    { key: "desc", width: undefined },
    { key: "count", width: 100 },
    { key: "viewer", width: 142 },
  ];
  // 詳細を開いている間の詰めた形（docs/design-system/screen-types.md の「型 B の変種」）：検査日時・患者 ID・氏名・年齢と性別（1 列）・モダリティと検査名。
  // 省く値（受付番号・カナ・生年月日・Se/Im・開く）は、詳細の見出し・検査の情報・操作の行で見る。
  // 年齢と性別は短い値なので 1 列にまとめる（一覧が 570px ほどでも、横にスクロールせずに収める）
  if (!compact) return all;
  const keep = (key: string) => all.filter((c) => c.key === key);
  // 詰めた形の日時は 2 行（日付／時刻。12px の 2 行を 28px の行に収める）にして切らない（docs/design-system/parts.md の「一覧＋右に詳細の幅」）
  // 既定の位置（一覧 45%）の 1280px の画面で、横にスクロールせずに収まる幅にする（氏名は詰めた形だけ下限を 88px に）
  return [
    { key: "date", width: COMPACT_DATE },
    ...keep("id"),
    { key: "name", width: fit((s) => s.patientName, 88, 200) },
    { key: "agesex", width: 72 },
    ...keep("desc"),
  ];
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

/**
 * 並べ替えの列見出し（docs/spec.md の 3.1。docs/design-system/components.md の「一覧の表」）。
 * 見出しは並べ替えのボタン。いまの並びの列は太字と矢印（昇順は上、降順は下）で示し、th に aria-sort を付ける
 */
function SortTh({
  sortKey,
  sort,
  onSort,
  children,
  className,
  title,
}: {
  sortKey: SortKey;
  sort: StudySort;
  onSort: (key: SortKey) => void;
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <SortableHead
      className={className}
      title={title}
      sort={sort.key === sortKey ? sort.dir : undefined}
      onSort={() => onSort(sortKey)}
      buttonTestId={`sort-${sortKey}`}
    >
      {children}
    </SortableHead>
  );
}

function StudyRows({
  studies,
  screen,
  selected,
  onSelect,
  onChanged,
  dim = false,
  empty,
  listKey,
  compact = false,
  sort,
  onSort,
}: {
  /** いまの並びと、列見出しを押したときの切り替え */
  sort: StudySort;
  onSort: (key: SortKey) => void;
  /** 詳細を開いている間（左右に分ける形の左）は、列を詰めた形にする（columnsFor） */
  compact?: boolean;
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
  /** 行が無いときに、表の中に出す案内（0 件でも、表の枠と見出しの行は出す。docs/spec.md の 3.1） */
  empty?: React.ReactNode;
}) {
  // 矢印で動く（ローヴィングの tabindex）：選んだ行、無ければ先頭の行だけが tab の止まり先
  const tabStop = studies.some((s) => s.studyInstanceUid === selected) ? selected : (studies[0]?.studyInstanceUid ?? null);
  // 受付番号の列は、許可の一覧に受付番号がある役割だけ（行に項目がある。0 件のときは見出しを出す）
  const showAccession = studies.length === 0 || studies.some((s) => Object.hasOwn(s, "accessionNumber"));
  const columns = columnsFor(studies, showAccession, compact);
  const has = (key: string) => columns.some((c) => c.key === key);
  const minWidth = columns.reduce((sum, c) => sum + (c.width ?? (compact ? DESC_MIN_COMPACT : DESC_MIN)), 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollAnchor(scrollRef, studies, listKey);
  return (
    <Table
      wrapperRef={scrollRef}
      onWrapperScroll={onScroll}
      label="検査の一覧"
      // 行の位置は useScrollAnchor が保つ（ブラウザのスクロールの寄せと二重に動かさない）。
      // @container：0 件の案内を、横にスクロールする表の幅ではなく、見えている一覧の幅の中に置くため（100cqw）
      wrapperClassName="@container min-h-0 flex-1 [overflow-anchor:none] rounded-md border border-border focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring md:min-h-56"
      wrapperTestId="study-list-scroll"
      // 取り直しの待ちの細い帯は、一覧の上の縁に重ねる（場所を取らない。画面は覆わない）
      overlay={
        dim && (
          <div className="sticky top-0 z-20 h-0">
            <div className="absolute inset-x-0 top-0">
              <ProgressBar />
            </div>
          </div>
        )
      }
      className="table-fixed"
      style={{ minWidth }}
      data-testid="study-table"
    >
        <colgroup>
          {columns.map((c) => (
            <col key={c.key} data-col={c.key} style={c.width ? { width: c.width } : undefined} />
          ))}
        </colgroup>
        <TableHeader>
          <tr className="h-7 border-b border-border">
            <SortTh sortKey="date" sort={sort} onSort={onSort}>
              検査日時
            </SortTh>
            <SortTh sortKey="id" sort={sort} onSort={onSort}>
              患者ID
            </SortTh>
            {has("accession") && (
              <SortTh sortKey="accession" sort={sort} onSort={onSort}>
                受付番号
              </SortTh>
            )}
            <SortTh sortKey="name" sort={sort} onSort={onSort} title="かなの氏名があれば、五十音順">
              氏名
            </SortTh>
            {has("kana") && (
              <SortTh sortKey="kana" sort={sort} onSort={onSort}>
                カナ
              </SortTh>
            )}
            {has("birth") && (
              <SortTh sortKey="birth" sort={sort} onSort={onSort}>
                生年月日
              </SortTh>
            )}
            {has("age") && (
              <SortTh sortKey="age" sort={sort} onSort={onSort}>
                年齢
              </SortTh>
            )}
            {has("sex") && (
              <SortTh sortKey="sex" sort={sort} onSort={onSort}>
                性別
              </SortTh>
            )}
            {has("agesex") && <TableHead>年齢・性別</TableHead>}
            <SortTh sortKey="desc" sort={sort} onSort={onSort}>
              モダリティ／検査名
            </SortTh>
            {has("count") && (
              <TableHead num title="シリーズ数／画像数">
                Se/Im
              </TableHead>
            )}
            {has("viewer") && (
              <TableHead>
                <span className="sr-only">ビューア</span>
              </TableHead>
            )}
          </tr>
        </TableHeader>
        <tbody className={cn("transition-opacity", dim && "opacity-60")} data-dim={dim || undefined}>
          {studies.length === 0 && empty && (
            <tr>
              <td colSpan={columns.length} className="p-0 text-label">
                {/* 表は列の幅の合計より狭くならない（狭い画面では横にスクロールする）。案内は見えている幅の中で中央に置く */}
                <div className="sticky left-0 flex w-[100cqw] justify-center px-2 py-8 text-center">{empty}</div>
              </td>
            </tr>
          )}
          {studies.map((s, i) => {
            const uid = s.studyInstanceUid ?? "";
            const isOpen = selected !== null && uid === selected;
            const dateTime = `${formatSlashDate(s.studyDate)} ${formatDicomTime(s.studyTime)}`.trim();
            const birthTitle = formatBirthWareki(s.patientBirthDate);
            const desc = [s.modalities?.join("・"), s.studyDescription].filter(Boolean).join(" ");
            return (
              <TableRow
                  key={uid || `row-${i}`}
                  data-study-uid={uid}
                  // 矢印で動く（ローヴィングの tabindex）。選んだ行は地 selected-strong と左 3px の primary で、太字にしない（ui/table）
                  tabIndex={uid === tabStop ? 0 : -1}
                  selected={isOpen}
                  // 行を押す・Space で選ぶ。行の中のビューアの部品の操作は、選ぶ操作にしない。行を選んでも一覧の行は動かない
                  onSelect={() => onSelect(uid, "click")}
                  // Enter は既定のビューアで開く（docs/spec.md の 3.1）
                  onOpen={() => openInViewer(uid, s.defaultViewer)}
                  onDoubleClick={(e) => {
                    if (isRowControl(e.target, e.currentTarget)) return;
                    openInViewer(uid, s.defaultViewer);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Escape") {
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
                  {compact ? (
                    // 詰めた形は 2 行（日付／時刻）にして切らない。12px の 2 行で 28px の行に収める（行の高さを変えない）
                    <TableCell className="text-xs leading-3.5 whitespace-nowrap tabular-nums" title={dateTime} data-testid="study-datetime">
                      <span className="block">{formatSlashDate(s.studyDate)}</span>
                      <span className="block text-label">{formatDicomTime(s.studyTime)}</span>
                    </TableCell>
                  ) : (
                    <TableCell className={cn(CUT, "tabular-nums")} title={dateTime} data-testid="study-datetime">
                      {formatSlashDate(s.studyDate)}
                      <span className="ml-1.5 text-label">{formatDicomTime(s.studyTime)}</span>
                    </TableCell>
                  )}
                  <td className={cn(CELL, "font-mono whitespace-nowrap")} data-testid="patient-id">
                    {s.patientId}
                  </td>
                  {has("accession") && (
                    <td className={cn(CELL, CUT, "font-mono")} title={s.accessionNumber} data-testid="accession-number">
                      {s.accessionNumber}
                    </td>
                  )}
                  <td className={cn(CELL, CUT)} title={s.patientName}>
                    {s.patientName ? (
                      <CellMain data-testid="patient-name">{s.patientName}</CellMain>
                    ) : (
                      <span className="text-label">（氏名未登録）</span>
                    )}
                  </td>
                  {has("kana") && (
                    <td className={cn(CELL, CUT, "text-label")} title={s.patientKana} data-testid="patient-kana">
                      {s.patientKana}
                    </td>
                  )}
                  {has("birth") && (
                    <td className={cn(CELL, "whitespace-nowrap tabular-nums")} title={birthTitle || undefined} data-testid="patient-birth">
                      {formatSlashDate(s.patientBirthDate)}
                    </td>
                  )}
                  {has("age") && (
                    <td className={cn(CELL, "whitespace-nowrap tabular-nums")} data-testid="patient-age">
                      {formatAge(s.patientBirthDate, s.studyDate)}
                    </td>
                  )}
                  {has("sex") && (
                    <td className={cn(CELL, "whitespace-nowrap")} data-testid="patient-sex">
                      {sexLabel(s.patientSex)}
                    </td>
                  )}
                  {has("agesex") && (
                    <td className={cn(CELL, "whitespace-nowrap tabular-nums")} data-testid="patient-agesex">
                      {formatAge(s.patientBirthDate, s.studyDate)} {sexLabel(s.patientSex)}
                    </td>
                  )}
                  <td className={cn(CELL, CUT)} title={desc}>
                    <span className="mr-2 inline-flex gap-1 align-middle">
                      {s.modalities?.map((m) => <ModalityMark key={m} modality={m} />)}
                    </span>
                    {s.studyDescription && <span className="text-label">{s.studyDescription}</span>}
                  </td>
                  {has("count") && (
                    <td className={cn(CELL, CUT, "num text-right tabular-nums")}>
                      {s.seriesCount ?? "—"}
                      <span className="text-label"> / </span>
                      {s.instanceCount ?? "—"}
                    </td>
                  )}
                  {has("viewer") && (
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
                  )}
                </TableRow>
            );
          })}
        </tbody>
    </Table>
  );
}

/**
 * 一覧の自動更新（docs/spec.md の 3.1）。seconds ごとに一覧の版（/api/studies/version。Orthanc の変更の記録の番号）を読み、
 * 版が変わったときだけ一覧を読み直す（変わらなければ検査の検索をしない）。選んだ行・スクロール・開いている詳細はそのまま
 * （詳細は読み直さない。「詳細を開いた」の記録を増やさない）。この読み直しの間は待ちの印を出さない（quiet）。
 * タブを隠している間は読まず、戻ったらすぐ読む。seconds が 0 なら何もしない。
 * 読み直しの要求を出す間は autoRef を true にし、一覧の要求に `refresh=auto` を付けさせる（監査の記録に trigger: "auto" が残る）。
 * hooks.tick は版を読むたび（読み直しの前）に、hooks.beforeAuto は一覧を読み直す直前に、hooks.afterAuto は答えが届いた後
 * （読めなかったときも）に呼ぶ（行の差し込みを待つかを決める。Browser）
 */
function useListRefresh(
  seconds: number,
  initialVersion: string | undefined,
  autoRef: React.RefObject<boolean>,
  hooks: React.RefObject<{ tick: () => void; beforeAuto: () => void; afterAuto: () => void }>,
) {
  const queryClient = useQueryClient();
  const [quiet, setQuiet] = useState(false);
  // 基準の版。サーバーが一覧を取る前に読んだ版。無ければ、最初に読んだ版を基準にする
  const base = useRef(initialVersion);
  const version = useQuery({
    queryKey: ["studies-version"],
    queryFn: async ({ signal }) => {
      const { version: next } = await getJson<{ version: string }>("/api/studies/version", signal);
      hooks.current.tick();
      if (base.current === undefined || base.current === next) {
        base.current = next;
        return next;
      }
      setQuiet(true);
      hooks.current.beforeAuto();
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
        hooks.current.afterAuto();
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
  initialSelected,
  screen,
}: {
  initialFilter: StudyFilter;
  initialData: StudyListData;
  /** サーバーの側で一覧を取った時刻（ミリ秒）。古くなった最初の値を新しいものとして使わない */
  initialDataAt: number;
  /** サーバーの側で一覧を取る前に読んだ、一覧の版（自動更新の基準） */
  initialVersion?: string;
  /** 開いたときに選んでおく検査（受信一覧の「検査一覧で表示」から。最初の一覧にある検査だけ） */
  initialSelected?: string;
  screen: ScreenInfo;
}) {
  const [filter, setFilter] = useState<StudyFilter>(initialFilter);
  const [selected, setSelected] = useState<string | null>(initialSelected ?? null);
  // 詳細を実際に取る検査。クリックならすぐ、矢印で移るときは止まってから（通り過ぎた行の「詳細を開いた」を記録しない）。
  // 開いたときに選んだ検査は、クリックと同じくすぐ取る（「詳細を開いた」を記録する）
  const [loadedUid, setLoadedUid] = useState<string | null>(initialSelected ?? null);
  // 開いたときに選んだ検査の行を、一覧の見える所に入れ、フォーカスを置く（矢印のキーでそのまま続けて動ける）
  const openedWith = useRef(initialSelected);
  useEffect(() => {
    const uid = openedWith.current;
    if (!uid) return;
    const row = document.querySelector<HTMLElement>(`[data-testid=study-table] tr[data-study-uid="${CSS.escape(uid)}"]`);
    if (!row) return;
    revealRow(row);
    row.focus({ preventScroll: true });
  }, []);
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

  const box = useRef<HTMLElement>(null);
  // 本文が左右に分けるには狭い（852px 未満）とき、詳細が一覧の上に重なる。開いたら詳細へフォーカスを移し、背後の一覧は操作・読み上げの対象から外し、閉じたら元の行へ戻す
  const narrow = useNarrowerThan(box, SPLIT_MIN_BODY_REM);
  const paneRef = useRef<HTMLDivElement>(null);
  const restoreUid = useRef<string | null>(null);

  const split = useSyncExternalStore(subscribeSplit, getSplit, getServerSplit);
  /** 一覧と詳細を左右に分ける場所（境目の位置はこの幅に対する百分率） */
  const body = useRef<HTMLDivElement>(null);
  const listId = useId();
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

  // 自動更新の行の差し込みを待つ（docs/spec.md の 3.1）：ポインタが一覧の上にある間と、一覧の中でキーを押してから 3 秒の間は、
  // 読み直した一覧を出さず、読み直す前の一覧（held）を出したままにする。押す直前に行がずれて、隣の検査を選ばないように。
  // 新しい行は件数の行の「新着 n 件」で知らせ、押すか、待つ理由が無くなった後の次の版の読み取りで出す。
  // 選んだ行は StudyInstanceUID で持つので、差し込んだ後も同じ検査を選んだまま
  const hold = useRef({ pointer: false, keyAt: Number.NEGATIVE_INFINITY });
  const [held, setHeld] = useState<{ key: string; data: StudyListData } | null>(null);
  /** 出していない新しい行（新着）と、出したままの消えた行の数。行の出入りが無い読み直し（画像の枚数が増えただけなど）は、
   * 行がずれないので、待たずに出す（null） */
  const waiting = useMemo(() => {
    if (!held || held.key !== params || !list.data || list.data === held.data) return null;
    const shown = new Set(held.data.studies.map((s) => s.studyInstanceUid));
    const next = new Set(list.data.studies.map((s) => s.studyInstanceUid));
    const added = list.data.studies.filter((s) => !shown.has(s.studyInstanceUid)).length;
    const removed = held.data.studies.filter((s) => !next.has(s.studyInstanceUid)).length;
    return added > 0 || removed > 0 ? { added, removed } : null;
  }, [held, params, list.data]);
  const data = waiting && held ? held.data : list.data;
  // fetching：読み直しを始める前から一覧を取っている（利用者の絞り込み・最初の読み込み。前の絞り込みの行を仮に出している間や、
  // 覚えている一覧を出しながら取り直している間）
  const latest = useRef({ params, shown: data, fetching: list.isFetching });
  useEffect(() => {
    latest.current = { params, shown: data, fetching: list.isFetching };
  });
  const refreshHooks = useRef({ tick: () => {}, beforeAuto: () => {}, afterAuto: () => {} });
  useEffect(() => {
    const holding = () => hold.current.pointer || Date.now() - hold.current.keyAt < KEY_HOLD_MS;
    const release = () => {
      if (!holding()) setHeld(null);
    };
    refreshHooks.current = {
      tick: release,
      // 読み直す前に、いま出している一覧を控える（待つかどうかは、答えが届いた時に決める。読み直しの間にポインタを
      // 一覧へ移しても差し込まない）。利用者の検索の答えを待っている間は控えない（求めた結果を、古い一覧の裏に隠さない）
      beforeAuto: () => {
        const { params: key, shown, fetching } = latest.current;
        if (fetching || !shown) setHeld(null);
        else setHeld({ key, data: shown });
      },
      // 答えが届いた時：待つ理由が無ければ、そのまま出す
      afterAuto: release,
    };
  }, []);
  // ポインタと、一覧の中で押したキーを数える（一覧の外の要素の操作は数えない）
  const listBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listBox.current;
    if (!el) return;
    const enter = () => (hold.current.pointer = true);
    const leave = () => (hold.current.pointer = false);
    const key = () => (hold.current.keyAt = Date.now());
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("keydown", key);
    return () => {
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("keydown", key);
    };
  }, []);
  const changed = () => {
    setHeld(null);
    void queryClient.invalidateQueries({ queryKey: ["studies"] });
  };
  // 列見出しでの並べ替え。読み込んだ検査（上限 1000 件）の中だけを、この画面で並べる。絞り込みを替えても並びは保つ
  const [sort, setSort] = useState<StudySort>(DEFAULT_SORT);
  const rows = useMemo(() => (data ? (isDefaultSort(sort) ? data.studies : sortStudies(data.studies, sort)) : []), [data, sort]);
  const onSort = useCallback((key: SortKey) => setSort((current) => nextSort(current, key)), []);
  const refreshSeconds = screen.refreshSeconds ?? 0;
  const refresh = useListRefresh(refreshSeconds, initialVersion, autoRefreshRef, refreshHooks);
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
    setHeld(null);
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
  /** 詳細を出しているか（出している間は、左右に分け、一覧の列を詰める。狭い画面では、一覧の上に重ねる） */
  const detailOpen = !!selectedRow;
  const overlayOpen = narrow && detailOpen;
  useEffect(() => {
    if (overlayOpen) paneRef.current?.focus({ preventScroll: true });
  }, [overlayOpen]);
  useEffect(() => {
    if (selectedRow || !restoreUid.current) return;
    const uid = restoreUid.current;
    restoreUid.current = null;
    box.current?.querySelector<HTMLElement>(`tr[data-study-uid="${CSS.escape(uid)}"]`)?.focus({ preventScroll: true });
  }, [selectedRow]);
  const closeDetail = () => {
    restoreUid.current = selected;
    select(null, "click");
  };

  return (
    // @container：左右に分けるかを、画面の幅ではなく本文の幅（53.25rem ＝ 852px）で決める（@[53.25rem]:）。JS 側の narrow（useNarrowerThan）と同じ値
    <section ref={box} data-split-root className="@container relative flex min-h-0 flex-1 flex-col gap-2">
      {/* 絞り込みの帯と件数の行は、左右をまたいで上に置く（docs/design-system/screen-types.md の「型 B の変種」） */}
      <div inert={overlayOpen || undefined} className="shrink-0 space-y-3">
        <FilterBar key={filterKey} filter={filter} facets={data?.facets} onChange={changeFilter} filtered={params !== ""} onClear={clearFilter} />
        {/* 件数の行（docs/design-system/components.md）：検索の欄が空かどうかで件数と自動更新の位置が動かない（#56） */}
        <CountRow
          aside={
            refreshSeconds > 0 && (
              <>
                {/* 差し込みを待っている新しい行（上の held）。押すと一覧に出す。読み上げの場所は常に置き、中身だけを替える */}
                <span aria-live="polite">
                  {waiting && (
                    <Button type="button" size="xs" variant="outline" data-testid="list-new" onClick={() => setHeld(null)}>
                      {waiting.added > 0 ? `新着 ${waiting.added} 件` : "一覧を更新"}
                    </Button>
                  )}
                </span>
                <span
                  className={cn("inline-flex items-center gap-1", refresh.failed && "text-danger")}
                  data-testid="list-refresh"
                  data-failed={refresh.failed || undefined}
                >
                  <RefreshCw aria-hidden className="size-3.5" />
                  {refresh.failed ? "自動更新：接続できません" : `自動更新（${refreshSeconds}秒）`}
                </span>
              </>
            )
          }
        >
          <div className="flex items-baseline gap-1" aria-live="polite" data-fetching={list.isFetching || undefined}>
            {/* 取り直しの待ちの印が出ている間は、件数を「—」にする（古い件数を新しいものに見せない） */}
            <span className="text-lg font-bold text-value" data-testid="study-count">
              {data && !refetching ? `${data.count.count}${data.count.exact ? "" : " 以上"}` : "—"}
            </span>
            <span className="text-label">件</span>
          </div>
          <PendingText pending={fetching} />
          {/* 上限に届いて読みきれていないとき、並べ替えは読んだ範囲の中だけ（最初の並びは新しい順の先頭なので、替えたときだけ添える） */}
          {data && !data.count.exact && !isDefaultSort(sort) && (
            <span className="text-sm text-label" data-testid="sort-limit-note">
              先頭の{STUDY_LIMIT}件の中で並べ替えています
            </span>
          )}
          {notice && (
            <Notice kind="ok" className="py-0.5" data-testid="list-notice">
              {notice}
            </Notice>
          )}
        </CountRow>
      </div>

      {list.isError && (
        <Notice kind="err" alert>
          {list.error.message}
        </Notice>
      )}
      {/* その下を左右に分ける。行を選ぶまでは一覧が全幅。選ぶと、左に一覧（列を詰めた形）、右に詳細（残りの幅） */}
      <div ref={body} className="flex min-h-0 flex-1">
      <div
        id={listId}
        inert={overlayOpen || undefined}
        className={cn(
          "flex min-h-0 min-w-0 flex-col",
          // 一覧は 440px（27.5rem）より、詳細は 400px（25rem）と境目の 12px（0.75rem）より縮まない（docs/design-system/parts.md の「一覧＋右に詳細の幅」）
          detailOpen
            ? "@max-[53.25rem]:flex-1 @[53.25rem]:max-w-[calc(100%-25rem-0.75rem)] @[53.25rem]:min-w-110 @[53.25rem]:flex-none @[53.25rem]:basis-(--split)"
            : "flex-1",
        )}
        style={{ "--split": `${split}%` } as React.CSSProperties}
        // 自動更新の行の差し込みを待つ間を数える場所（上の hold）
        ref={listBox}
      >
      {/* 0 件でも表の枠と見出しの行を出し、一覧の場所が分かるようにする（2026-10-21。空の場所が真っ白だった） */}
      <StudyRows
        compact={detailOpen && !narrow}
        studies={rows}
        sort={sort}
        onSort={onSort}
        // 前の絞り込みの行を出している間（placeholder）は、別の印にする（新しい絞り込みの行で、見ていた行の位置を戻さない）。
        // 並びを替えたときも別の印にする（並びが替わった行で、見ていた行の位置を戻さない）
        listKey={list.isPlaceholderData ? "placeholder" : `list:${params}:${sort.key}:${sort.dir}`}
        screen={screen}
        selected={selected}
        onSelect={pick}
        onChanged={changed}
        dim={refetching}
        // 0 件の案内は、一覧を読めたときだけ。読み込みの間と読めなかったときは、中身の無い行を作らない（待ちの印は一覧の上の細い帯）
        empty={
          data ? (
            <span className="inline-flex flex-wrap items-center justify-center gap-3" data-testid="study-list-empty">
              <Inbox aria-hidden className="size-5" />
              該当する検査はありません
              {/* 絞り込みが既定のままなら、戻す先が無いのでボタンを出さない */}
              {params !== "" && (
                <Button type="button" size="sm" variant="outline" onClick={clearFilter}>
                  条件をクリア
                </Button>
              )}
            </span>
          ) : undefined
        }
      />
      </div>

      {selectedRow && (
      <>
      {/* 境目：左右に動かせる（矢印の左右・Home・End・ドラッグ）。狭い画面では左右に分けない */}
      {/* 動かせる境目は WAI-ARIA の focusable separator（widget）。jsx-a11y はこの形を知らないので、2つの規則だけ外す */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="一覧と詳細の境界"
        aria-controls={listId}
        aria-valuemin={SPLIT_MIN}
        aria-valuemax={SPLIT_MAX}
        aria-valuenow={split}
        aria-valuetext={`一覧 ${split}%`}
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        data-testid="split-handle"
        className="group hidden w-3 shrink-0 cursor-col-resize touch-none items-center justify-center focus-visible:outline-none @[53.25rem]:flex"
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
          if (!e.currentTarget.hasPointerCapture(e.pointerId) || !body.current) return;
          const rect = body.current.getBoundingClientRect();
          if (rect.width > 0) setSplit(((e.clientX - rect.left) / rect.width) * 100);
        }}
      >
        <span aria-hidden className="h-16 w-1 rounded-full bg-border group-hover:bg-label group-focus-visible:bg-ring" />
      </div>

      {/* 右：選んだ検査の詳細。狭い画面では、一覧の上に重ねて出す。詳細の中の Escape・× で閉じる（メニューが開いているときはメニューが先） */}
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
        className="bg-surface focus-visible:outline-none @max-[53.25rem]:absolute @max-[53.25rem]:inset-0 @max-[53.25rem]:z-30 @max-[53.25rem]:overflow-auto @[53.25rem]:min-h-0 @[53.25rem]:min-w-100 @[53.25rem]:flex-1 @[53.25rem]:overflow-auto @[53.25rem]:rounded-md @[53.25rem]:border @[53.25rem]:border-border"
      >
        <button
          type="button"
          aria-label="詳細を閉じる"
          onClick={closeDetail}
          className={cn(
            "sticky top-0 float-right z-20 m-2 rounded p-1 text-label hover:bg-hover active:bg-pressed focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            pressFeedback,
          )}
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
      </div>
      </>
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
  initialSelected?: string;
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
