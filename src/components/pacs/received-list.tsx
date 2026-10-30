"use client";

import { ArrowRight, ChevronLeft, ChevronRight, RotateCw, Search } from "lucide-react";
import Link from "next/link";
import type * as React from "react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants, pressInset } from "@/components/ui/button";
import { CountRow } from "@/components/ui/count-row";
import { Input } from "@/components/ui/input";
import { Notice } from "@/components/ui/notice";
import { ActionButton, PendingText } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
import { StatusBadge } from "@/components/ui/status-badge";
import { PINNED_CELL, PINNED_HEAD } from "@/components/ui/table";
import { getJson } from "@/lib/client/api";
import {
  forgetPreviousSeen,
  getPreviousSeen,
  getServerPreviousSeen,
  isNewArrival,
  latestReceivedAt,
  rememberSeen,
  subscribePreviousSeen,
} from "@/lib/client/received-seen";
import type { ReceivedView } from "@/lib/fields";
import { formatDateTimeIn } from "@/lib/format/japanese-date";
import { RECEIVE_PERIOD_LABELS, RECEIVE_PERIODS, receivePeriodQuery, type ReceivePeriodKind } from "@/lib/receive-period";
import { normalizeForSearch } from "@/lib/study-filter";
import { cn } from "@/lib/utils";

// 受信一覧（docs/spec.md の 3.3。送受信の一覧の受ける側の形。docs/design-system/components.md の「送受信の一覧」）。
// 上から 検索の帯（期間・送信元 AE・患者ID と氏名・新着のみ）→ 上限の知らせ → 件数の行 → 表 → ページ送り。
// - 期間（今日・昨日・過去7日・期間を指定）は BFF が Orthanc の変更の記録を遡って集める（画面の API /api/receive-log）。
//   期間を替えると、頁を読み直さずに画面の API から読み、URL の問い合わせも替える（開き直すと同じ期間）。
// - 期間の中が上限（1,000 件）を超えたら、新しい 1,000 件だけを出し、上限の知らせを出す。
// - 送信元 AE・患者ID と氏名・新着のみは、読んだ期間の中で画面で絞る。ページ送りは絞った後の行に当てる。
// - 状態の要約は出さない（状態が 受信中・受信完了 の 2 つで、3 つ以上の一覧だけに置く決まり）。
// - 新着の印：前にこの頁を開いたとき（このブラウザ）より後に受信した行（src/lib/client/received-seen.ts）。
// - 「検査一覧で表示」はボタンの形のリンク（頁の移動なのでリンク）。検査一覧でその検査を選び、詳細を開いた形で開く。

const CELL = "h-7 px-2 py-0 overflow-hidden text-ellipsis whitespace-nowrap";
/** 新着の行（地 selected/50）の、右端に固定した操作の列の地。透けないよう、背景の色と混ぜた不透明の色にする */
const FRESH_PINNED =
  "[tr[data-new]:not([data-selected]):not(:hover)>&]:bg-[color-mix(in_oklab,var(--color-selected)_50%,var(--color-background))]";
const PAGE_SIZES = [20, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

export interface ReceivedPeriodView {
  kind: ReceivePeriodKind;
  from: string;
  to: string;
}

export interface ReceivedLogView {
  items: ReceivedView[];
  overLimit: boolean;
  complete: boolean;
  period: ReceivedPeriodView;
}

/** 入った道。DICOM の C-STORE 以外（REST で入れたなど）は「インポート」と分かるようにする（画面の言葉は docs/spec.md の 2.2） */
function originText(origin: string | null | undefined): string {
  if (origin === "DicomProtocol") return "";
  if (origin === "RestApi") return "インポート";
  return origin ?? "";
}

/** 行の送信元（AE タイトル。無ければ入った道の言葉） */
const sourceOf = (r: ReceivedView) => r.remoteAet ?? originText(r.origin);

/** 検査一覧で、その検査を選んだ形で開く URL（患者ID で絞り、StudyInstanceUID の検査を選ぶ） */
export function studyListHref(r: ReceivedView): string | null {
  const params = new URLSearchParams();
  if (r.study.patientId) params.set("q", r.study.patientId);
  if (r.study.studyInstanceUid) params.set("studyUid", r.study.studyInstanceUid);
  return params.size > 0 ? `/?${params}` : null;
}

/** 数を、画面の数の書き方（3 桁ごとの区切り）にする */
const countText = (n: number) => n.toLocaleString("ja-JP");

/** 期間の切り替え（押すとすぐ読む）。選んだものは aria-pressed と地の色で示す */
function PeriodChip({ pressed, onClick, children, testId }: { pressed: boolean; onClick: () => void; children: React.ReactNode; testId: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center whitespace-nowrap border-r border-border px-2 text-sm last:border-r-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset",
        pressInset,
        pressed ? "bg-primary text-primary-foreground hover:bg-primary-hover active:bg-primary-active" : "bg-background text-foreground hover:bg-hover active:bg-pressed",
      )}
    >
      {children}
    </button>
  );
}

export function ReceivedList({
  initial,
  initialError = null,
  timeZone,
  limit,
}: {
  initial: ReceivedLogView;
  initialError?: string | null;
  timeZone: string;
  limit: number;
}) {
  const [log, setLog] = useState(initial);
  const items = log.items;
  // 期間の欄の値（期間を指定の開始日・終了日は、両方がそろって読める形になってから読む）
  const [kind, setKind] = useState<ReceivePeriodKind>(initial.period.kind);
  const [from, setFrom] = useState(initial.period.from);
  const [to, setTo] = useState(initial.period.to);
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  // 選んだ行（クリック・矢印のキー）。行の鍵で持つので、絞り込みや再読み込みで並びが変わっても同じ行を指す
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  // 後から求めた読み込みだけを画面に出す（先に求めた答えが後から届いても、上書きしない）
  const request = useRef<AbortController | null>(null);

  // 前に開いたときの受信日時（頁を開いている間は替えない）。見た受信日時を覚え、頁を離れたら忘れる
  const previous = useSyncExternalStore(subscribePreviousSeen, getPreviousSeen, getServerPreviousSeen);
  useEffect(() => {
    rememberSeen(latestReceivedAt(items.map((r) => r.receivedAt)));
  }, [items]);
  useEffect(
    () => () => {
      forgetPreviousSeen();
      request.current?.abort();
    },
    [],
  );

  async function load(period: ReceivedPeriodView) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    const query = receivePeriodQuery(period);
    try {
      const r = await getJson<ReceivedLogView>(`/api/receive-log${query.size > 0 ? `?${query}` : ""}`, controller.signal);
      if (controller.signal.aborted) return;
      setLog(r);
      setPage(0);
      // 開き直すと同じ期間になるように、URL の問い合わせを替える（頁は読み直さない）
      window.history.replaceState(null, "", `/received${query.size > 0 ? `?${query}` : ""}`);
    } catch (e) {
      if (controller.signal.aborted) return;
      setError((e as Error).message);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }

  function choosePeriod(next: ReceivePeriodKind) {
    setKind(next);
    if (next !== "range") void load({ kind: next, from: "", to: "" });
    else if (from && to && from <= to) void load({ kind: "range", from, to });
  }

  function chooseRange(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    if (nextFrom && nextTo && nextFrom <= nextTo) void load({ kind: "range", from: nextFrom, to: nextTo });
  }

  // 選んでいる送信元は、再読み込みで読んだ範囲から消えても選択肢に残す（選択の欄の見た目と絞り込みを食い違わせない）
  const sources = useMemo(() => [...new Set([...items.map(sourceOf), source].filter(Boolean))].sort(), [items, source]);
  const newCount = items.filter((r) => isNewArrival(r.receivedAt, previous)).length;
  const needle = normalizeForSearch(text);
  const shown = items.filter((r) => {
    if (source && sourceOf(r) !== source) return false;
    if (onlyNew && !isNewArrival(r.receivedAt, previous)) return false;
    if (!needle) return true;
    return [r.study.patientId, r.study.patientName, r.study.patientKana].some((v) => typeof v === "string" && normalizeForSearch(v).includes(needle));
  });
  const filtered = !!source || !!needle || onlyNew;
  const pages = Math.max(1, Math.ceil(shown.length / pageSize));
  const current = Math.min(page, pages - 1);
  const pageRows = shown.slice(current * pageSize, (current + 1) * pageSize);
  const badRange = kind === "range" && !!from && !!to && from > to;

  // 行の鍵：検査と受信日時。同じ組が重なる行（受信日時が無い行など）は、読んだ並びの何番目かを添える。絞り込みで並びが変わっても、鍵は変わらない
  const keys = useMemo(() => {
    const seen = new Map<string, number>();
    return new Map(
      items.map((r) => {
        const base = `${r.study.studyInstanceUid ?? "row"}-${r.receivedAt ?? ""}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        return [r, n === 0 ? base : `${base}#${n}`] as const;
      }),
    );
  }, [items]);
  const keyOf = (r: ReceivedView) => keys.get(r) ?? "";
  // 矢印のキーの止まり先（フォーカスを受ける行は 1 つ）。選んだ行が表に無いときは先頭
  const tabStopKey = pageRows.some((r) => keyOf(r) === pickedKey) ? pickedKey : pageRows[0] ? keyOf(pageRows[0]) : null;

  function clearConditions() {
    setSource("");
    setText("");
    setOnlyNew(false);
    setPage(0);
  }

  const periodLabel =
    log.period.kind === "range" ? `${log.period.from.replaceAll("-", "/")}〜${log.period.to.replaceAll("-", "/")}` : RECEIVE_PERIOD_LABELS[log.period.kind];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* 検索の帯（muted-strong の地。押すとすぐ絞り込むので「検索」は置かず、「条件をクリア」だけを右に置く） */}
      <form
        role="search"
        aria-label="条件"
        noValidate
        onSubmit={(e) => e.preventDefault()}
        className="flex flex-wrap items-center gap-3 rounded-md bg-muted-strong px-4 py-3"
        data-testid="received-filters"
      >
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-label" id="received-period-label">
            期間
          </span>
          <div role="group" aria-labelledby="received-period-label" className="inline-flex overflow-hidden rounded-md border border-border">
            {RECEIVE_PERIODS.map((p) => (
              <PeriodChip key={p} pressed={kind === p} onClick={() => choosePeriod(p)} testId={`received-period-${p}`}>
                {RECEIVE_PERIOD_LABELS[p]}
              </PeriodChip>
            ))}
          </div>
          {kind === "range" && (
            <span className="flex items-center gap-1">
              <Input
                type="date"
                aria-label="開始日"
                value={from}
                onChange={(e) => chooseRange(e.target.value, to)}
                aria-invalid={badRange || undefined}
                className="h-7 w-40 bg-background"
                data-testid="received-from"
              />
              <span className="text-label">〜</span>
              <Input
                type="date"
                aria-label="終了日"
                value={to}
                onChange={(e) => chooseRange(from, e.target.value)}
                aria-invalid={badRange || undefined}
                className="h-7 w-40 bg-background"
                data-testid="received-to"
              />
            </span>
          )}
        </div>
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-label">送信元 AE</span>
          <Select
            size="sm"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPage(0);
            }}
            className="w-36"
            data-testid="received-source"
          >
            <option value="">すべて</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </label>
        <div className="relative w-56 max-w-full">
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-label" />
          <Input
            type="search"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPage(0);
            }}
            placeholder="患者ID・氏名"
            aria-label="受信一覧の検索"
            className="h-7 bg-background pl-8"
            data-testid="received-search"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={onlyNew}
          disabled={newCount === 0 && !onlyNew}
          onClick={() => {
            setOnlyNew((v) => !v);
            setPage(0);
          }}
          className={cn("h-7", onlyNew ? "bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover" : "bg-background")}
          data-testid="received-only-new"
        >
          新着のみ（{newCount}）
        </Button>
        <Button type="button" size="sm" variant="outline" className="ml-auto h-7 bg-background" disabled={!filtered} onClick={clearConditions} data-testid="received-clear">
          条件をクリア
        </Button>
      </form>

      {error && (
        <Notice kind="err" alert data-testid="received-error">
          {error}
        </Notice>
      )}
      {badRange && (
        <Notice kind="err" alert data-testid="received-range-error">
          受信一覧の期間を読み込めません。開始日が終了日より後です。期間を選び直してください
        </Notice>
      )}
      {log.overLimit && (
        <Notice kind="warn" data-testid="received-over-limit">
          受信が {countText(limit)} 件を超えたため、新しい {countText(limit)} 件だけを出しています。期間を狭めてください。
        </Notice>
      )}
      {!log.complete && (
        <Notice kind="warn" data-testid="received-incomplete">
          期間の古い側の受信を読み込めませんでした。Orthanc の変更の記録を期間の始まりまで読めませんでした。期間を狭めてください。
        </Notice>
      )}

      {/* 件数の行：件数を帯の中に混ぜない。読み込みの間は件数を「—」にする */}
      <CountRow
        aside={
          <>
            <span data-testid="received-period">{periodLabel}・新しい順</span>
            <ActionButton
              type="button"
              size="sm"
              variant="outline"
              pending={loading}
              icon={<RotateCw aria-hidden />}
              onClick={() => void load(log.period)}
              data-testid="received-reload"
            >
              再読み込み
            </ActionButton>
          </>
        }
      >
        <p className="flex items-baseline gap-1" aria-live="polite">
          <span className="text-lg font-bold text-value" data-testid="received-count">
            {loading ? "—" : shown.length}
          </span>
          <span className="text-label">{filtered && !loading ? `／${items.length} 件` : "件"}</span>
        </p>
        <PendingText pending={loading} />
      </CountRow>

      {/* 見出しの行を上に残すため、表の中でスクロールする（頁の高さに収める） */}
      <div className="max-h-[calc(100dvh-18rem)] min-h-40 overflow-auto rounded-md border border-border" role="region" aria-label="受信の一覧" data-testid="received-scroll">
        <table className="w-full min-w-[1000px] table-fixed border-collapse" data-testid="received-table">
          <colgroup>
            {/* 受信日時（秒まで。「新着」の印も入る）と札・ボタンの列は、値が切れない幅にする。残りの幅はモダリティと検査名へ */}
            <col style={{ width: 188 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 128 }} />
            <col style={{ width: 120 }} />
            <col />
            <col style={{ width: 56 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 152 }} />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-label shadow-[0_1px_0_var(--color-border)]">
            <tr className="h-7 border-b border-border">
              <th className="px-2 py-0 font-normal">受信日時</th>
              <th className="px-2 py-0 font-normal">送信元 AE</th>
              <th className="px-2 py-0 font-normal">患者ID</th>
              <th className="px-2 py-0 font-normal">氏名</th>
              <th className="px-2 py-0 font-normal">モダリティ／検査名</th>
              <th className="px-2 py-0 text-right font-normal">画像数</th>
              <th className="px-2 py-0 font-normal">状態</th>
              <th className={cn("px-2 py-0 font-normal", PINNED_HEAD)}>
                <span className="sr-only">操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center" data-testid="received-none">
                  <b className="block text-value">{periodLabel}の受信はありません。</b>
                  <span className="text-label">期間を変えてください。</span>
                </td>
              </tr>
            )}
            {items.length > 0 && shown.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center text-label" data-testid="received-empty">
                  該当する受信履歴はありません
                </td>
              </tr>
            )}
            {pageRows.map((r) => {
              const desc = [r.study.modalities?.join("・"), r.study.studyDescription].filter(Boolean).join(" ");
              const origin = originText(r.origin);
              const fresh = isNewArrival(r.receivedAt, previous);
              const href = studyListHref(r);
              const rowKey = keyOf(r);
              const isPicked = rowKey === pickedKey;
              return (
                <tr
                  key={rowKey}
                  // 選んだ行は、検査一覧と同じ（selected-strong の地と左 3px の線）。太字にしない（幅が変わる）。新着の薄い地より優先する
                  className={cn(
                    "cursor-pointer border-b border-border last:border-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    isPicked
                      ? "bg-selected-strong [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-primary)]"
                      : cn("hover:bg-muted", fresh && "bg-selected/50"),
                  )}
                  data-testid="received-row"
                  data-new={fresh || undefined}
                  data-selected={isPicked || undefined}
                  aria-selected={isPicked}
                  tabIndex={rowKey === tabStopKey ? 0 : -1}
                  onClick={(e) => {
                    // 行の中のリンク（検査一覧で表示）は、選ぶ操作にしない
                    if ((e.target as HTMLElement).closest("a")) return;
                    setPickedKey(rowKey);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const next = (e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
                      const nextKey = next?.dataset.rowKey;
                      if (!next || !nextKey) return;
                      next.focus({ preventScroll: true });
                      next.scrollIntoView({ block: "nearest" });
                      setPickedKey(nextKey);
                    } else if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      setPickedKey(rowKey);
                    } else if (e.key === "Escape") {
                      setPickedKey(null);
                    }
                  }}
                  data-row-key={rowKey}
                >
                  <td className={CELL} data-testid="received-at">
                    {fresh && (
                      <Badge className="mr-1.5" data-testid="received-new">
                        新着
                      </Badge>
                    )}
                    {r.receivedAt ? formatDateTimeIn(r.receivedAt, timeZone, { seconds: true }) : ""}
                  </td>
                  <td className={cn(CELL, "font-mono")} title={r.remoteAet ?? origin}>
                    {r.remoteAet}
                    {origin && (
                      <Badge className={cn("font-sans", r.remoteAet && "ml-1.5")} data-testid="received-origin">
                        {origin}
                      </Badge>
                    )}
                    {!r.remoteAet && !origin && <span className="text-label">—</span>}
                  </td>
                  <td className={cn(CELL, "font-mono")} title={r.study.patientId}>
                    {r.study.patientId}
                  </td>
                  <td className={cn(CELL, "font-bold")} title={r.study.patientName}>
                    {r.study.patientName}
                  </td>
                  <td className={CELL} title={desc}>
                    {desc}
                  </td>
                  <td className={cn(CELL, "text-right tabular-nums")}>{r.receivedInstances ?? ""}</td>
                  <td className={CELL} data-testid="received-state">
                    {r.receiveState === "receiving" ? (
                      <StatusBadge kind="wait">受信中</StatusBadge>
                    ) : r.receiveState === "received" ? (
                      <StatusBadge kind="ok">受信完了</StatusBadge>
                    ) : (
                      <span className="text-label">—</span>
                    )}
                  </td>
                  {/* 操作の列は右端に固定する（表が横にスクロールしても見切らない）。新着の行は、行と同じ薄い地にそろえる */}
                  <td className={cn("h-7 px-2 py-0 text-right", PINNED_CELL, FRESH_PINNED)} data-testid="received-actions">
                    {href && (
                      // 頁の移動なのでリンク。押せる物と分かるように、ボタンの形にする
                      <Link href={href} className={buttonVariants({ variant: "outline", size: "xs" })} data-testid="received-open">
                        検査一覧で表示
                        <ArrowRight aria-hidden />
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ページ送り：左に何件目か、右に 1 ページの件数とページの操作 */}
      {shown.length > 0 && (
        <nav aria-label="ページ送り" className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="received-pager">
          <span className="text-label" data-testid="received-range">
            {current * pageSize + 1}〜{Math.min((current + 1) * pageSize, shown.length)} 件目／全 {shown.length} 件
          </span>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5">
              <span className="text-xs text-label">1 ページに</span>
              <Select
                size="sm"
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(0);
                }}
                data-testid="received-page-size"
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n} 件
                  </option>
                ))}
              </Select>
            </label>
            <Button type="button" size="sm" variant="outline" disabled={current === 0} onClick={() => setPage(current - 1)} data-testid="received-prev">
              <ChevronLeft aria-hidden />
              前のページ
            </Button>
            <span className="text-label tabular-nums" data-testid="received-page-no">
              {current + 1} / {pages}
            </span>
            <Button type="button" size="sm" variant="outline" disabled={current >= pages - 1} onClick={() => setPage(current + 1)} data-testid="received-next">
              次のページ
              <ChevronRight aria-hidden />
            </Button>
          </div>
        </nav>
      )}
    </div>
  );
}
