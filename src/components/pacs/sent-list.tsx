"use client";

import { ArrowRight, Check, Copy, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { CountRow } from "@/components/ui/count-row";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getJson } from "@/lib/client/api";
import {
  DEFAULT_PAGE_SIZE,
  destinations,
  EMPTY_SENT_FILTER,
  matchesSent,
  PAGE_SIZES,
  pageSlice,
  SENT_STATUS_KINDS,
  SENT_STATUS_LABELS,
  sentLimitNotice,
  sentStatusNote,
  sentStudyHref,
  statusCounts,
  type SentFilter,
} from "@/lib/client/sent-list";
import { SENT_STATUSES, type SentStatus, type SentView } from "@/lib/fields";
import { formatDateTimeIn, formatDicomTime, formatSlashDate } from "@/lib/format/japanese-date";
import { cn } from "@/lib/utils";

// 送信一覧の表（docs/spec.md の 3.4。送受信の一覧の送る側の形。docs/design-system/components.md・parts.md）。
// 上から 状態の要約（押すと絞る）→ 検索の帯（期間・送信先・患者ID と氏名）→ 上限の知らせ → 件数の行 → 表 → ページ送り →
// 選んだ行の詳細（一覧＋下に詳細）。読むだけで、書き込みの操作は置かない（再送信は検査の詳細の「送信」から）。
// 期間を替えて「検索」を押すと BFF から読み直す。送信先・患者ID と氏名・状態は、読んだ範囲の中で絞る。
// 行はクリックか、行に移って Enter・Space で選ぶ。矢印の上下で隣の行へ移って選ぶ。Esc で詳細を閉じる。

type Period = "today" | "yesterday" | "week" | "range";
const PERIOD_LABELS: Record<Period, string> = { today: "今日", yesterday: "昨日", week: "過去7日", range: "期間を指定" };

interface Applied {
  period: Period;
  from: string;
  to: string;
}

interface SentResponse {
  items: SentView[];
  truncated: boolean;
  limit: number;
}

const NOW_TIME = (timeZone: string) => formatDateTimeIn(new Date().toISOString(), timeZone).slice(-5);

function query(a: Applied): string {
  const p = new URLSearchParams({ period: a.period });
  if (a.period === "range") {
    p.set("from", a.from);
    p.set("to", a.to);
  }
  return `/api/sent-log?${p}`;
}

export function SentList({ timeZone, limit }: { timeZone: string; limit: number }) {
  // 帯に入れている条件（「検索」を押すまで反映しない）と、反映した条件
  const [draft, setDraft] = useState<Applied & Pick<SentFilter, "destination" | "text">>({
    period: "today",
    from: "",
    to: "",
    ...EMPTY_SENT_FILTER,
  });
  const [applied, setApplied] = useState<Applied & { round: number }>({ period: "today", from: "", to: "", round: 0 });
  const [filter, setFilter] = useState<SentFilter>(EMPTY_SENT_FILTER);
  const [data, setData] = useState<SentResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedAt, setLoadedAt] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [picked, setPicked] = useState<string | null>(null);
  const [rangeProblem, setRangeProblem] = useState<string | null>(null);
  const ids = { period: useId(), from: useId(), to: useId(), dest: useId(), text: useId(), size: useId(), range: useId() };

  // 反映した条件が替わるたび（同じ期間でも「検索」を押すたび。round が進む）に BFF から読む。
  // 読み込み中の印は、呼ぶ側（検索・条件をクリア）が先に立てる（最初は立っている）
  useEffect(() => {
    const ctrl = new AbortController();
    getJson<SentResponse>(query(applied), ctrl.signal).then(
      (r) => {
        setError(null);
        setData(r);
        setLoadedAt(NOW_TIME(timeZone));
        setLoading(false);
      },
      (e: unknown) => {
        if (ctrl.signal.aborted) return;
        setError(`送信一覧を取得できませんでした（${NOW_TIME(timeZone)}）。${(e as Error).message}`);
        setLoading(false);
      },
    );
    return () => ctrl.abort();
  }, [applied, timeZone]);

  const items = useMemo(() => data?.items ?? [], [data]);
  const matched = useMemo(() => items.filter((i) => matchesSent(i, filter)), [items, filter]);
  const counts = useMemo(() => statusCounts(matched), [matched]);
  const shown = useMemo(() => (filter.status === "all" ? matched : matched.filter((i) => i.status === filter.status)), [matched, filter.status]);
  const slice = pageSlice(shown, page, pageSize);
  const choices = destinations(items, draft.destination);
  const filtered = !!filter.destination || !!filter.text || filter.status !== "all";
  const selected = picked ? (items.find((i) => i.requestId === picked) ?? null) : null;
  // 矢印のキーの止まり先（フォーカスを受ける行は 1 つ）。選んだ行がこのページに無いときは先頭
  const tabStop = slice.rows.some((r) => r.requestId === picked) ? picked : (slice.rows[0]?.requestId ?? null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft.period === "range") {
      if (!draft.from || !draft.to) {
        setRangeProblem("期間の開始日と終了日を入力してください。");
        return;
      }
      if (draft.to < draft.from) {
        setRangeProblem("終了日は開始日と同じ日か、後の日にしてください。");
        return;
      }
    }
    setRangeProblem(null);
    setFilter((f) => ({ ...f, destination: draft.destination, text: draft.text }));
    setPage(1);
    setLoading(true);
    // 同じ期間でも「検索」は読み直す（新しい送信を読む）
    setApplied((a) => ({ period: draft.period, from: draft.from, to: draft.to, round: a.round + 1 }));
  }

  function clear() {
    setDraft({ period: "today", from: "", to: "", ...EMPTY_SENT_FILTER });
    setFilter(EMPTY_SENT_FILTER);
    setRangeProblem(null);
    setPage(1);
    setPicked(null);
    setLoading(true);
    setApplied((a) => ({ period: "today", from: "", to: "", round: a.round + 1 }));
  }

  function pickStatus(status: SentStatus | "all") {
    setFilter((f) => ({ ...f, status }));
    setPage(1);
  }

  return (
    <div className="space-y-3" data-testid="sent-list">
      {/* 状態の要約。押すとその状態で絞る（もう一度「すべて」で戻す） */}
      <div className="flex flex-wrap gap-2" role="group" aria-label="状態の件数" data-testid="sent-summary">
        {(["all", ...SENT_STATUSES] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filter.status === s}
            onClick={() => pickStatus(s)}
            className={cn(
              "inline-flex h-7 items-center gap-2 rounded-md border px-2 text-sm text-value focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              filter.status === s ? "border-primary bg-selected-strong" : "border-border bg-background hover:bg-hover",
            )}
            data-testid={`sent-sum-${s}`}
          >
            {s === "all" ? <span>すべて</span> : <StatusBadge kind={SENT_STATUS_KINDS[s]}>{SENT_STATUS_LABELS[s]}</StatusBadge>}
            <span className="font-bold tabular-nums">{loading ? "—" : counts[s]}</span>
          </button>
        ))}
      </div>

      {/* 検索の帯（期間・送信先・患者ID と氏名）。右に「検索」（主）と「条件をクリア」（副） */}
      <form
        role="search"
        aria-label="条件"
        noValidate
        onSubmit={submit}
        className="flex flex-wrap items-end gap-3 rounded-md bg-muted-strong px-4 py-3"
        data-testid="sent-searchband"
      >
        <label className="flex flex-col gap-1" htmlFor={ids.period}>
          <span className="text-xs text-label">期間</span>
          <select
            id={ids.period}
            value={draft.period}
            onChange={(e) => setDraft((d) => ({ ...d, period: e.target.value as Period }))}
            className="h-8 rounded-md border border-border bg-background px-2 text-sm text-value"
            data-testid="sent-period"
          >
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
              <option key={p} value={p}>
                {PERIOD_LABELS[p]}
              </option>
            ))}
          </select>
        </label>
        {draft.period === "range" && (
          <div className="flex items-end gap-1">
            <label className="flex flex-col gap-1" htmlFor={ids.from}>
              <span className="text-xs text-label">開始日</span>
              <Input
                id={ids.from}
                type="date"
                value={draft.from}
                onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
                className="w-40"
                aria-invalid={rangeProblem ? true : undefined}
                aria-describedby={rangeProblem ? ids.range : undefined}
                data-testid="sent-from"
              />
            </label>
            <span className="pb-1.5 text-label">〜</span>
            <label className="flex flex-col gap-1" htmlFor={ids.to}>
              <span className="text-xs text-label">終了日</span>
              <Input
                id={ids.to}
                type="date"
                value={draft.to}
                onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
                className="w-40"
                aria-invalid={rangeProblem ? true : undefined}
                aria-describedby={rangeProblem ? ids.range : undefined}
                data-testid="sent-to"
              />
            </label>
          </div>
        )}
        <label className="flex flex-col gap-1" htmlFor={ids.dest}>
          <span className="text-xs text-label">送信先</span>
          <select
            id={ids.dest}
            value={draft.destination}
            onChange={(e) => setDraft((d) => ({ ...d, destination: e.target.value }))}
            className="h-8 min-w-32 rounded-md border border-border bg-background px-2 text-sm text-value"
            data-testid="sent-destination"
          >
            <option value="">すべて</option>
            {choices.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1" htmlFor={ids.text}>
          <span className="text-xs text-label">患者ID・氏名</span>
          <Input
            id={ids.text}
            type="search"
            value={draft.text}
            onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
            className="w-56"
            data-testid="sent-text"
          />
        </label>
        <div className="ml-auto flex gap-2">
          <Button type="submit" data-testid="sent-search">
            検索
          </Button>
          <Button type="button" variant="outline" onClick={clear} data-testid="sent-clear">
            条件をクリア
          </Button>
        </div>
        {rangeProblem && (
          <p id={ids.range} className="w-full text-xs text-danger" data-testid="sent-range-problem">
            ✕ {rangeProblem}
          </p>
        )}
      </form>

      {error && (
        <div role="alert" className="flex items-center gap-2 border-l-4 border-danger bg-surface px-3 py-2 text-sm text-value" data-testid="sent-error">
          <span aria-hidden className="text-danger">
            ✕
          </span>
          {error}
        </div>
      )}
      {data?.truncated && (
        <div role="status" className="flex items-center gap-2 border-l-4 border-warning bg-surface px-3 py-2 text-sm text-value" data-testid="sent-limit">
          <span aria-hidden className="text-warning">
            ！
          </span>
          {sentLimitNotice(limit)}
        </div>
      )}

      <CountRow
        aside={
          <>
            <span>受付日時の新しい順</span>
            {loadedAt && <span>{loadedAt} に取得</span>}
          </>
        }
      >
        <span aria-live="polite">
          <b className="text-lg text-value" data-testid="sent-count">
            {loading ? "—" : shown.length}
          </b>{" "}
          <span className="text-label">{filtered && !loading ? `件／${items.length} 件` : "件"}</span>
        </span>
      </CountRow>

      <div role="region" aria-label="送信一覧の表" className="rounded-md border border-border">
        <Table className="min-w-[1080px] table-fixed text-sm" data-testid="sent-table">
          <colgroup>
            <col style={{ width: 136 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 120 }} />
            <col style={{ width: 150 }} />
            <col />
            <col style={{ width: 72 }} />
            <col style={{ width: 104 }} />
            <col style={{ width: 88 }} />
            <col style={{ width: 152 }} />
          </colgroup>
          <TableHeader className="sticky top-0 z-10 bg-surface">
            <TableRow className="h-7 hover:bg-transparent">
              <TableHead className="h-7">受付日時</TableHead>
              <TableHead className="h-7">送信先</TableHead>
              <TableHead className="h-7">患者ID</TableHead>
              <TableHead className="h-7">氏名</TableHead>
              <TableHead className="h-7">モダリティと検査名</TableHead>
              <TableHead className="h-7 text-right">画像数</TableHead>
              <TableHead className="h-7">状態</TableHead>
              <TableHead className="h-7">保管の確認</TableHead>
              <TableHead className="h-7">
                <span className="sr-only">操作</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!loading && slice.rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={9} className="py-8">
                  <div className="flex flex-col items-center gap-1 text-center" data-testid="sent-empty">
                    <b className="text-value">{items.length === 0 ? "この期間の送信ジョブはありません。" : "条件に合う送信ジョブはありません。"}</b>
                    <span className="text-label">
                      {items.length === 0 ? "期間を変えて、もう一度検索してください。" : "条件を変えるか、「条件をクリア」を押してください。"}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {slice.rows.map((r) => {
              const key = r.requestId ?? "";
              const isPicked = key === picked;
              const href = sentStudyHref(r);
              const desc = [r.study.modalities?.join("・"), r.study.studyDescription].filter(Boolean).join(" ");
              return (
                <TableRow
                  key={key}
                  data-row-key={key}
                  data-testid="sent-row"
                  aria-selected={isPicked}
                  tabIndex={key === tabStop ? 0 : -1}
                  className={cn(
                    "h-10 cursor-pointer focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    isPicked ? "bg-selected-strong hover:bg-selected-strong [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-primary)]" : "hover:bg-muted",
                  )}
                  onClick={(e) => {
                    // 行の中のリンク（検査一覧で表示）は、選ぶ操作にしない
                    if ((e.target as HTMLElement).closest("a")) return;
                    setPicked(key);
                  }}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setPicked(key);
                    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                      e.preventDefault();
                      const next = (e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
                      const nextKey = next?.dataset.rowKey;
                      if (!next || !nextKey) return;
                      next.focus();
                      setPicked(nextKey);
                    } else if (e.key === "Escape") {
                      setPicked(null);
                    }
                  }}
                >
                  <TableCell className="truncate tabular-nums" data-testid="sent-at">
                    {formatDateTimeIn(r.requestedAt, timeZone)}
                  </TableCell>
                  <TableCell className="truncate" title={r.destinationAet ? `${r.destination}（${r.destinationAet}）` : r.destination}>
                    {r.destination}
                  </TableCell>
                  <TableCell className="truncate font-mono" title={r.study.patientId}>
                    {r.study.patientId || "—"}
                  </TableCell>
                  <TableCell className="truncate" title={r.study.patientName}>
                    {r.study.patientName ? (
                      <>
                        <span className="block truncate font-bold text-value">{r.study.patientName}</span>
                        {r.study.patientKana && <span className="block truncate text-xs text-label">{r.study.patientKana}</span>}
                      </>
                    ) : (
                      <span className="text-label">—</span>
                    )}
                  </TableCell>
                  <TableCell className="truncate" title={desc}>
                    {desc || <span className="text-label">—</span>}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.study.instanceCount ?? "—"}</TableCell>
                  <TableCell data-testid="sent-status">
                    {r.status && <StatusBadge kind={SENT_STATUS_KINDS[r.status]}>{SENT_STATUS_LABELS[r.status]}</StatusBadge>}
                  </TableCell>
                  {/* 保管の確認（Storage Commitment）は、いまの送信では求めていない */}
                  <TableCell className="text-label" data-testid="sent-commit">
                    —
                  </TableCell>
                  <TableCell className="text-right">
                    {href && (
                      // 頁の移動なのでリンク。押せる物と分かるように、ボタンの形にする（受信一覧と同じ）
                      <Link href={href} className={buttonVariants({ variant: "outline", size: "xs" })} data-testid="sent-open">
                        検査一覧で表示
                        <ArrowRight aria-hidden />
                      </Link>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {/* ページ送り（1 ページに 20・50・100 件） */}
      <nav aria-label="ページ" className="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="sent-pager">
        <span className="text-label" data-testid="sent-range">
          {slice.first}〜{slice.last} 件目／全 {shown.length} 件
        </span>
        <div className="flex items-center gap-2">
          <label htmlFor={ids.size} className="text-xs text-label">
            1 ページに
          </label>
          <select
            id={ids.size}
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
            className="h-7 rounded-md border border-border bg-background px-2 text-sm text-value"
            data-testid="sent-page-size"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} 件
              </option>
            ))}
          </select>
          <Button type="button" size="sm" variant="outline" disabled={slice.page <= 1} onClick={() => setPage(slice.page - 1)} data-testid="sent-prev">
            前のページ
          </Button>
          <span className="text-xs text-label tabular-nums">
            {slice.page}／{slice.pages}
          </span>
          <Button type="button" size="sm" variant="outline" disabled={slice.page >= slice.pages} onClick={() => setPage(slice.page + 1)} data-testid="sent-next">
            次のページ
          </Button>
        </div>
      </nav>

      {selected && <SentDetail item={selected} timeZone={timeZone} onClose={() => setPicked(null)} />}
    </div>
  );
}

/** 選んだ行の詳細（一覧の下）。患者バナーの並びの項目と、送信の項目・Study UID の行 */
function SentDetail({ item, timeZone, onClose }: { item: SentView; timeZone: string; onClose: () => void }) {
  const note = sentStatusNote(item);
  const s = item.study;
  const studyAt = `${formatSlashDate(s.studyDate)} ${formatDicomTime(s.studyTime)}`.trim();
  const rows: [string, ReactNode, boolean?][] = [
    ["受付日時", formatDateTimeIn(item.requestedAt, timeZone) || "—"],
    ["完了日時", item.finishedAt ? formatDateTimeIn(item.finishedAt, timeZone) : "—"],
    ["送信先", item.destinationAet ? `${item.destination}（${item.destinationAet}）` : item.destination || "—"],
    ["検査日時", studyAt || "—"],
    ["受付番号", s.accessionNumber || "—", !!s.accessionNumber],
    ["要求ID", item.requestId ?? "—", true],
  ];
  return (
    <section aria-label="送信の詳細" className="space-y-2 rounded-md border border-border bg-background p-3" data-testid="sent-detail">
      <div className="flex flex-wrap items-start gap-x-6 gap-y-2 rounded-md border border-border bg-surface px-3 py-1.5" aria-label="患者">
        <div className="min-w-0">
          <p className="text-base font-bold text-value">{s.patientName || "—"}</p>
          {s.patientKana && <p className="text-xs text-label">{s.patientKana}</p>}
        </div>
        <dl className="min-w-0">
          <dt className="text-xs text-label">患者ID</dt>
          <dd className="font-mono text-value">{s.patientId || "—"}</dd>
        </dl>
        <dl className="min-w-0">
          <dt className="text-xs text-label">モダリティと検査名</dt>
          <dd className="font-bold text-value">{[s.modalities?.join("・"), s.studyDescription].filter(Boolean).join(" ") || "—"}</dd>
        </dl>
        <div className="ml-auto flex items-center gap-2">
          {item.status && <StatusBadge kind={SENT_STATUS_KINDS[item.status]}>{SENT_STATUS_LABELS[item.status]}</StatusBadge>}
          <Button type="button" size="sm" variant="ghost" aria-label="詳細を閉じる" onClick={onClose} data-testid="sent-detail-close">
            <X aria-hidden />
          </Button>
        </div>
      </div>
      {note && (
        <p className="text-sm text-value" data-testid="sent-note">
          {note}
        </p>
      )}
      <dl className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-6 gap-y-1">
        {rows.map(([label, value, mono]) => (
          <div key={label} className="min-w-0">
            <dt className="text-xs text-label">{label}</dt>
            <dd className={cn("break-all text-value", mono && "font-mono")}>{value}</dd>
          </div>
        ))}
      </dl>
      {s.studyInstanceUid && <UidRow uid={s.studyInstanceUid} />}
    </section>
  );
}

function UidRow({ uid }: { uid: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <div className="flex items-baseline gap-2" data-testid="sent-uid">
      <span className="shrink-0 text-xs text-label">Study UID</span>
      <code className="min-w-0 font-mono text-[0.75rem] break-all text-label">{uid}</code>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-6"
        aria-label="Study UID をコピー"
        onClick={() => void navigator.clipboard.writeText(uid).then(() => setDone(true), () => undefined)}
      >
        {done ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
      <span role="status" className="text-xs text-label">
        {done ? "コピーしました" : ""}
      </span>
    </div>
  );
}
