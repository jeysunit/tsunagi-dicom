"use client";

import { ArrowRight, RotateCw, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionButton } from "@/components/ui/pending";
import { Select } from "@/components/ui/select";
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
import { formatDateTimeIn, formatSlashDate } from "@/lib/format/japanese-date";
import { normalizeForSearch } from "@/lib/study-filter";
import { cn } from "@/lib/utils";

// 受信一覧の表（docs/spec.md の 3.3）。件数が多くても目当ての行を探せるように（2026-10-21。承認者の指摘）：
// - 絞り込み：送信元 AE（読んだ行にあるものから選ぶ）・検索（患者ID・氏名・検査名）・新着のみ。読んだ範囲（直近の件数）の中で絞る。
// - 新着の印：前にこの頁を開いたとき（このブラウザ）より後に受信した行（src/lib/client/received-seen.ts）。
// - 再読み込み：頁を読み直さずに、画面の API（/api/receive-log。開いたことは操作ログに残る）から読み直す。
// - 見出しの行は、表の中でスクロールしても上に残る。
// - 「検査一覧で表示」はボタンの形のリンク（頁の移動なのでリンク）。検査一覧でその検査を選び、詳細を開いた形で開く。

const CELL = "h-7 px-2 py-0 overflow-hidden text-ellipsis whitespace-nowrap";

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

export function ReceivedList({
  initialItems,
  initialComplete,
  timeZone,
  limit,
}: {
  initialItems: ReceivedView[];
  initialComplete: boolean;
  timeZone: string;
  limit: number;
}) {
  const [items, setItems] = useState(initialItems);
  const [complete, setComplete] = useState(initialComplete);
  const [source, setSource] = useState("");
  const [text, setText] = useState("");
  const [onlyNew, setOnlyNew] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 選んだ行（クリック・矢印のキー）。行の鍵で持つので、絞り込みや再読み込みで並びが変わっても同じ行を指す
  const [pickedKey, setPickedKey] = useState<string | null>(null);

  // 前に開いたときの受信日時（頁を開いている間は替えない）。見た受信日時を覚え、頁を離れたら忘れる
  const previous = useSyncExternalStore(subscribePreviousSeen, getPreviousSeen, getServerPreviousSeen);
  useEffect(() => {
    rememberSeen(latestReceivedAt(items.map((r) => r.receivedAt)));
  }, [items]);
  useEffect(() => () => forgetPreviousSeen(), []);

  // 選んでいる送信元は、再読み込みで読んだ範囲から消えても選択肢に残す（選択の欄の見た目と絞り込みを食い違わせない）
  const sources = useMemo(() => [...new Set([...items.map(sourceOf), source].filter(Boolean))].sort(), [items, source]);
  const newCount = items.filter((r) => isNewArrival(r.receivedAt, previous)).length;
  const needle = normalizeForSearch(text);
  const shown = items.filter((r) => {
    if (source && sourceOf(r) !== source) return false;
    if (onlyNew && !isNewArrival(r.receivedAt, previous)) return false;
    if (!needle) return true;
    return [r.study.patientId, r.study.patientName, r.study.patientKana, r.study.studyDescription].some(
      (v) => typeof v === "string" && normalizeForSearch(v).includes(needle),
    );
  });
  const filtered = !!source || !!needle || onlyNew;
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
  const tabStopKey = shown.some((r) => keyOf(r) === pickedKey) ? pickedKey : shown[0] ? keyOf(shown[0]) : null;

  async function reload() {
    setReloading(true);
    setError(null);
    try {
      const r = await getJson<{ items: ReceivedView[]; complete: boolean }>("/api/receive-log");
      setItems(r.items);
      setComplete(r.complete);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReloading(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5" role="group" aria-label="受信一覧の絞り込み" data-testid="received-filters">
        <label className="flex items-center gap-1.5">
          <span className="text-xs text-label">送信元 AE</span>
          <Select size="sm" value={source} onChange={(e) => setSource(e.target.value)} data-testid="received-source">
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
            onChange={(e) => setText(e.target.value)}
            placeholder="患者ID・氏名・検査名"
            aria-label="受信一覧の検索"
            className="h-7 pl-8"
            data-testid="received-search"
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={onlyNew}
          disabled={newCount === 0 && !onlyNew}
          onClick={() => setOnlyNew((v) => !v)}
          className={cn(onlyNew && "bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover")}
          data-testid="received-only-new"
        >
          新着のみ（{newCount}）
        </Button>
        <p className="flex items-baseline gap-1" aria-live="polite">
          <span className="text-lg font-bold text-value" data-testid="received-count">
            {shown.length}
          </span>
          <span className="text-label">{filtered ? `／${items.length} 件` : "件"}</span>
        </p>
        <ActionButton type="button" size="sm" variant="outline" pending={reloading} icon={<RotateCw aria-hidden />} onClick={() => void reload()} data-testid="received-reload">
          再読み込み
        </ActionButton>
        {/* 読める範囲の説明（Orthanc の変更の記録の数に限りがある）は title に回す（画面に説明の文を置かない。docs/spec.md の 2.2） */}
        <span className="text-xs text-label" title="Orthanc の変更の記録から読める範囲です。古い記録は Orthanc に残らないことがあります">
          直近 {limit} 件
        </span>
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {!complete && (
        <p role="status" className="text-xs text-danger" data-testid="received-incomplete">
          一部の履歴を読み込めませんでした。抜けがないか Orthanc で確認してください
        </p>
      )}
      {items.length === 0 ? (
        <p className="text-label">受信履歴はありません</p>
      ) : (
        // 見出しの行を上に残すため、表の中でスクロールする（頁の高さに収める）
        <div className="max-h-[calc(100dvh-12rem)] overflow-auto rounded-md border border-border" data-testid="received-scroll">
          <table className="w-full min-w-[1000px] table-fixed border-collapse" data-testid="received-table">
            <colgroup>
              {/* 受信日時（秒まで。「新着」の印も入る）とボタンの列は、値が切れない幅にする */}
              <col style={{ width: 216 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 80 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 100 }} />
              <col />
              <col style={{ width: 152 }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-label shadow-[0_1px_0_var(--color-border)]">
              <tr className="border-b border-border">
                <th className="px-2 py-1 font-normal">受信日時</th>
                <th className="px-2 py-1 font-normal">送信元 AE</th>
                <th className="px-2 py-1 text-right font-normal">画像数</th>
                <th className="px-2 py-1 font-normal">患者ID</th>
                <th className="px-2 py-1 font-normal">氏名</th>
                <th className="px-2 py-1 font-normal">検査日</th>
                <th className="px-2 py-1 font-normal">モダリティ／検査名</th>
                <th className="px-2 py-1 font-normal">
                  <span className="sr-only">表示</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-2 py-6 text-center text-label" data-testid="received-empty">
                    該当する受信履歴はありません
                  </td>
                </tr>
              )}
              {shown.map((r) => {
                const desc = [r.study.modalities?.join("・"), r.study.studyDescription].filter(Boolean).join(" ");
                const origin = originText(r.origin);
                const fresh = isNewArrival(r.receivedAt, previous);
                const href = studyListHref(r);
                const rowKey = keyOf(r);
                const isPicked = rowKey === pickedKey;
                return (
                  <tr
                    key={rowKey}
                    // 選んだ行は、検査一覧と同じ（selected の地と左 3px の線）。新着の薄い地より優先する
                    className={cn(
                      "cursor-pointer border-b border-border last:border-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      isPicked
                        ? "bg-selected font-bold [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-ring)]"
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
                      } else if (e.key === " ") {
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
                        <span className="mr-1.5 rounded bg-primary px-1 text-xs text-primary-foreground" data-testid="received-new">
                          新着
                        </span>
                      )}
                      {r.receivedAt ? formatDateTimeIn(r.receivedAt, timeZone, { seconds: true }) : ""}
                    </td>
                    <td className={cn(CELL, "font-mono")} title={r.remoteAet ?? origin}>
                      {r.remoteAet ?? <span className="text-label">{origin || "—"}</span>}
                    </td>
                    <td className={cn(CELL, "text-right")}>{r.receivedInstances ?? ""}</td>
                    <td className={cn(CELL, "font-mono")} title={r.study.patientId}>
                      {r.study.patientId}
                    </td>
                    <td className={CELL} title={r.study.patientName}>
                      {r.study.patientName}
                    </td>
                    <td className={CELL}>{formatSlashDate(r.study.studyDate)}</td>
                    <td className={CELL} title={desc}>
                      {origin && (
                        <span className="mr-1.5 rounded border border-border px-1 text-xs text-label" data-testid="received-origin">
                          {origin}
                        </span>
                      )}
                      {desc}
                    </td>
                    <td className="h-7 px-2 py-0 text-right">
                      {href && (
                        // 頁の移動なのでリンク。押せる物と分かるように、ボタンの形にする（2026-10-21。前は文字のリンク）
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
      )}
    </>
  );
}
