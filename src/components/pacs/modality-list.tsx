"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ModalityMark } from "@/components/ui/modality-mark";
import { Notice as NoticeBar } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { ActionButton } from "@/components/ui/pending";
import { StatusBadge } from "@/components/ui/status-badge";
import { PINNED_HEAD } from "@/components/ui/table";
import { ApiError, getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import { SENT_STATUS_KINDS, SENT_STATUS_LABELS } from "@/lib/client/sent-list";
import { SENT_STATUSES, type ModalityView, type ReceivedView, type SentView } from "@/lib/fields";
import { formatDateTimeIn } from "@/lib/format/japanese-date";
import { loadFailed } from "@/lib/ui-text";
import { cn } from "@/lib/utils";

// 接続先の表と接続確認（docs/spec.md の 3.3。フェーズ 4）。1 件 1 行。「接続確認」で Orthanc から C-ECHO を送る。
// 「最後の接続確認」の列は、未確認（状態バッジ。確認できる相手でまだ確認していない）・確認中（状態バッジ。その行のボタンは押せない）・成功（状態バッジと時刻）・失敗（状態バッジと時刻と理由の 1 句）。
// 名称の行を選ぶと、表の下に接続先の詳細（設定・接続確認・今日の受信・今日の送信）を出す（docs/design-system/components.md の「接続先の詳細」）。
// 今日の受信・今日の送信は、今日の分の新しい 5 件だけ。全部は「受信一覧で全部見る」「送信一覧で全部見る」で、相手（AEタイトル）で絞った一覧を開く。
// 画面の言葉は docs/spec.md の 2.2、文の型は docs/design-system/writing.md。

interface EchoResult {
  ok: boolean;
  /** 確認した時刻（`10:32:05`） */
  at: string;
  /** 失敗の理由の 1 句（なぜか＋次にすること）。成功のときは無い */
  reason?: string;
  /** 失敗のうち、C-ECHO が通らなかったと BFF が正常に答えたもの。false は、確認そのものを終えられなかった（断られた要求・通信の失敗など） */
  unreachable?: boolean;
}

type Row = EchoResult | "busy";

interface Notice {
  kind: "info" | "ok" | "err";
  text: string;
}

/** 詳細に出す今日の記録の数 */
const RECENT = 5;

/** 今日の記録の読み込み。許されない役割（403）は、その区画を出さない。それ以外の失敗は区画に誤りを出す */
type Part<T> = { items: T[]; partial: boolean } | { forbidden: true } | { failed: string };

interface TodayLogs {
  received: Part<ReceivedView>;
  sent: Part<SentView>;
}

async function readPart<T>(url: string, signal: AbortSignal, what: string): Promise<Part<T>> {
  try {
    const body = await getJson<{ items: T[]; overLimit?: boolean; complete?: boolean; truncated?: boolean }>(url, signal);
    // 上限を超えた（新しい 1,000 件だけ）・期間の始まりまで遡れなかったときは、件数が少なく出るので「以上」と書く
    return { items: body.items, partial: !!body.overLimit || !!body.truncated || body.complete === false };
  } catch (e) {
    if (signal.aborted || (e instanceof DOMException && e.name === "AbortError")) throw e;
    if (e instanceof ApiError && e.status === 403) return { forbidden: true };
    return { failed: e instanceof ApiError ? e.message : loadFailed(what) };
  }
}

/**
 * BFF の応答から言えるのは「つながった」「つながらなかった」と、BFF が返した誤りの文だけ。
 * 断られた・AE タイトルが合わない・ホスト名を引けない、の見分けは応答に無いので、原因は分からないと書く
 */
function unreachableReason(canSeeAddress: boolean): string {
  return canSeeAddress
    ? "原因は分かりません。ホスト名・ポート番号・AEタイトルを確認して、もう一度接続確認してください。"
    : "原因は分かりません。管理者に、登録の確認を頼んでください。";
}

/** 「最後の接続確認」の中身。表の行と詳細で同じ状態バッジにする（読み上げの役割は表の行だけが持つ） */
function EchoState({ r, live }: { r: Row | undefined; live: boolean }) {
  if (r === undefined) return <StatusBadge kind="plan">未確認</StatusBadge>;
  if (r === "busy") {
    return (
      <span role={live ? "status" : undefined} data-testid={live ? "echo-result" : "detail-echo-result"} data-state="check">
        <StatusBadge kind="check">確認中</StatusBadge>
      </span>
    );
  }
  return (
    <span
      className="flex flex-wrap items-center gap-x-2"
      role={live ? (r.ok ? "status" : "alert") : undefined}
      data-testid={live ? "echo-result" : "detail-echo-result"}
      data-state={r.ok ? "ok" : "ng"}
    >
      <StatusBadge kind={r.ok ? "ok" : "ng"}>{r.ok ? "成功" : "失敗"}</StatusBadge>
      <span className="text-xs text-label">{r.at}</span>
      {!r.ok && r.reason && (
        <span className="text-xs text-foreground" data-testid={live ? "echo-why" : "detail-echo-why"}>
          {r.reason}
        </span>
      )}
    </span>
  );
}

export function ModalityList({ modalities, csrfToken, timeZone }: { modalities: ModalityView[]; csrfToken?: string; timeZone: string }) {
  const [results, setResults] = useState<Record<string, Row>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [logs, setLogs] = useState<TodayLogs | null>(null);
  // state は描画の後に変わるので、二重の押しはここで止める
  const running = useRef(new Set<string>());
  const noticeSeq = useRef(0);
  const showAddress = modalities.some((m) => m.host !== undefined);
  const ids = modalities.map((m) => m.id ?? "");
  const anyBusy = ids.some((id) => results[id] === "busy");
  const allBusy = ids.length > 0 && ids.every((id) => results[id] === "busy");
  const selected = picked === null ? null : (modalities.find((m) => (m.id ?? "") === picked) ?? null);

  // 詳細を初めて開いたときに、今日の受信と送信を読む（行を替えても読み直さない。1 回で足りる）
  const wantLogs = selected !== null;
  useEffect(() => {
    if (!wantLogs || logs !== null) return;
    const ctrl = new AbortController();
    void (async () => {
      try {
        const [received, sent] = await Promise.all([
          readPart<ReceivedView>("/api/receive-log?period=today", ctrl.signal, "今日の受信"),
          readPart<SentView>("/api/sent-log?period=today", ctrl.signal, "今日の送信"),
        ]);
        setLogs({ received, sent });
      } catch {
        // 取り消し（画面を離れた）だけがここへ来る
      }
    })();
    return () => ctrl.abort();
  }, [wantLogs, logs]);

  async function echo(id: string): Promise<EchoResult | null> {
    if (running.current.has(id)) return null;
    running.current.add(id);
    setResults((r) => ({ ...r, [id]: "busy" }));
    try {
      const result = await postJson(`/api/modalities/${encodeURIComponent(id)}/echo`, {}, csrfToken);
      const at = formatDateTimeIn(new Date().toISOString(), timeZone, { seconds: true }).split(" ")[1] ?? "";
      const ok = result.ok && result.data.connected === true;
      const reason = ok ? undefined : result.ok ? unreachableReason(showAddress) : errorText(result);
      const done: EchoResult = { ok, at, reason, unreachable: !ok && result.ok };
      setResults((r) => ({ ...r, [id]: done }));
      return done;
    } finally {
      running.current.delete(id);
    }
  }

  async function echoOne(id: string) {
    if (running.current.has(id)) return;
    const seq = ++noticeSeq.current;
    setNotice({ kind: "info", text: `${id} の接続確認を受け付けました。結果は、下の表の「最後の接続確認」で分かります。` });
    const done = await echo(id);
    if (!done || seq !== noticeSeq.current) return;
    setNotice(
      done.ok
        ? { kind: "ok", text: `${id} に接続できました（${done.at}）。` }
        : {
            kind: "err",
            text: done.unreachable
              ? `${id} に接続できませんでした（${done.at}）。理由は、下の表の「最後の接続確認」に出ています。`
              : `${id} の接続確認を終えられませんでした（${done.at}）。接続先につながるかは分かりません。理由は、下の表の「最後の接続確認」に出ています。`,
          },
    );
  }

  // 失敗した接続先があっても、残りの確認は続ける。全部が終わってから件数を知らせる
  async function echoAll() {
    const targets = ids.filter((id) => !running.current.has(id));
    if (targets.length === 0) return;
    const seq = ++noticeSeq.current;
    setNotice({ kind: "info", text: `${targets.length} 件の接続確認を受け付けました。結果は、下の表の「最後の接続確認」で分かります。` });
    const done = (await Promise.all(targets.map((id) => echo(id)))).filter((d): d is EchoResult => d !== null);
    if (seq !== noticeSeq.current) return;
    const unreachable = done.filter((d) => d.unreachable).length;
    const unfinished = done.filter((d) => !d.ok && !d.unreachable).length;
    if (unreachable === 0 && unfinished === 0) {
      setNotice({ kind: "ok", text: `${done.length} 件すべてに接続できました。` });
      return;
    }
    const parts = [
      unreachable > 0 ? `${unreachable} 件に接続できませんでした` : "",
      unfinished > 0 ? `${unfinished} 件は確認を終えられず、接続できるかは分かりません` : "",
    ].filter(Boolean);
    setNotice({ kind: "err", text: `${done.length} 件のうち、${parts.join("。")}。理由は、下の表の「最後の接続確認」に出ています。` });
  }

  function onRowKey(e: KeyboardEvent<HTMLTableRowElement>, id: string) {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setPicked(id);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = (e.key === "ArrowDown" ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling) as HTMLElement | null;
      const nextId = next?.dataset.modality;
      if (!next || nextId === undefined) return;
      next.focus();
      setPicked(nextId);
    } else if (e.key === "Escape") {
      setPicked(null);
    }
  }

  // 矢印のキーの止まり先（フォーカスを受ける行は 1 つ）。選んだ行が無いときは先頭
  const tabStop = picked !== null && ids.includes(picked) ? picked : (ids[0] ?? null);

  return (
    <section className="space-y-2" data-testid="modalities-page">
      <PageHeader
        title="接続先"
        actions={
          <ActionButton
            type="button"
            size="sm"
            variant="outline"
            pending={allBusy}
            disabled={modalities.length === 0 || anyBusy}
            onClick={() => void echoAll()}
            data-testid="echo-all"
          >
            すべて接続確認
          </ActionButton>
        }
      />
      {notice && (
        <NoticeBar kind={notice.kind} data-testid="echo-notice" data-k={notice.kind}>
          {notice.text}
        </NoticeBar>
      )}
      {modalities.length === 0 ? (
        <p className="rounded-md border border-border bg-surface px-3 py-2 text-label">接続先が登録されていません</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-border bg-surface">
          <div className="overflow-auto bg-background">
            <table className="w-full border-collapse" data-testid="modality-table">
              <thead className="bg-surface text-left text-xs text-label">
                <tr className="border-b border-border">
                  <th className="px-2 py-1 font-normal">名称</th>
                  <th className="px-2 py-1 font-normal">種類</th>
                  <th className="px-2 py-1 font-normal">AEタイトル</th>
                  {showAddress && <th className="px-2 py-1 font-normal">ホスト名:ポート番号</th>}
                  <th className="px-2 py-1 font-normal">最後の接続確認</th>
                  <th className={cn("px-2 py-1 font-normal", PINNED_HEAD)}>操作</th>
                </tr>
              </thead>
              <tbody>
                {modalities.map((m) => {
                  const id = m.id ?? "";
                  const r = results[id];
                  const isPicked = id === picked;
                  return (
                    <tr
                      key={id}
                      className={cn(
                        "cursor-pointer border-b border-border last:border-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                        isPicked ? "bg-selected-strong [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-ring)]" : "hover:bg-muted",
                      )}
                      data-testid="modality-row"
                      data-modality={id}
                      data-selected={isPicked || undefined}
                      aria-selected={isPicked}
                      tabIndex={id === tabStop ? 0 : -1}
                      onClick={(e) => {
                        // 行の中のボタンは、選ぶ操作にしない
                        if ((e.target as HTMLElement).closest("button")) return;
                        setPicked(id);
                      }}
                      onKeyDown={(e) => onRowKey(e, id)}
                    >
                      <td className="h-7 px-2 py-0 font-bold text-value">{id}</td>
                      {/* この画面の接続先は Orthanc に登録された DICOM だけ。HL7 の接続先は、この画面にまだ無い */}
                      <td className="h-7 px-2 py-0">DICOM</td>
                      <td className="h-7 px-2 py-0 font-mono">{m.aet}</td>
                      {showAddress && (
                        <td className="h-7 px-2 py-0 font-mono text-label">
                          {m.host}
                          {m.port != null ? `:${m.port}` : ""}
                        </td>
                      )}
                      <td className="h-7 px-2 py-0" data-testid="echo-cell">
                        <EchoState r={r} live />
                      </td>
                      {/* 操作の列は右端に固定する（狭い画面で表が横にスクロールしても見切らない）。地は行の地にそろえる */}
                      <td
                        className="sticky right-0 h-7 bg-background px-2 py-0 [tr:not([data-selected]):hover>&]:bg-muted [tr[data-selected]>&]:bg-selected-strong"
                        data-testid="modality-actions"
                      >
                        <ActionButton type="button" size="xs" variant="outline" pending={r === "busy"} onClick={() => void echoOne(id)} data-testid="echo">
                          接続確認
                        </ActionButton>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {selected && (
            <ModalityDetail
              modality={selected}
              showAddress={showAddress}
              result={results[selected.id ?? ""]}
              logs={logs}
              timeZone={timeZone}
              onEcho={() => void echoOne(selected.id ?? "")}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** 接続先の詳細の区画（デザインシステムの `.sec`）。題は 14px・行の高さ 20px・地 surface */
function Sec({ title, className, flush, children }: { title: string; className?: string; flush?: boolean; children: ReactNode }) {
  return (
    <section className={cn("min-w-0 rounded-md border border-border bg-background", className)}>
      <h2 className="rounded-t-md border-b border-border bg-surface px-3 py-2 text-sm leading-5 font-bold text-value">{title}</h2>
      {/* 表を主にする区画は、内側の余白を持たず表を端から端まで広げる（デザインシステムの `.in.flush`。ui-kit 1.2.9） */}
      <div className={flush ? "overflow-hidden rounded-b-[5px]" : "px-4 py-3"}>{children}</div>
    </section>
  );
}

function Kv({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] items-baseline gap-x-4 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-xs text-label">{label}</dt>
          <dd className="min-w-0 font-bold break-all text-value">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 接続先の詳細（表の下）。設定・接続確認・今日の受信・今日の送信 の 4 区画を 2 列の格子で並べる（760px 以下は 1 列） */
function ModalityDetail({
  modality,
  showAddress,
  result,
  logs,
  timeZone,
  onEcho,
}: {
  modality: ModalityView;
  showAddress: boolean;
  result: Row | undefined;
  logs: TodayLogs | null;
  timeZone: string;
  onEcho: () => void;
}) {
  const id = modality.id ?? "";
  const aet = modality.aet ?? "";
  const aetQuery = encodeURIComponent(aet);
  const address = `${modality.host ?? ""}${modality.port != null ? `:${modality.port}` : ""}`;
  const setting: [string, ReactNode][] = [
    ["名称", id],
    ["種類", "DICOM"],
    ["AEタイトル", <span key="aet" className="font-mono">{aet}</span>],
    ...(showAddress ? [["ホスト名:ポート番号", <span key="host" className="font-mono">{address}</span>] as [string, ReactNode]] : []),
    ["登録元", "Orthanc"],
  ];
  const received = logs && "items" in logs.received ? logs.received.items.filter((r) => r.remoteAet === aet) : null;
  // 同じ AE タイトルの接続先が複数あっても、送信先は AE タイトルで結ぶ（記録に AE タイトルが無いときだけ名称）
  const sent = logs && "items" in logs.sent ? logs.sent.items.filter((s) => (s.destinationAet ? s.destinationAet === aet : s.destination === id)) : null;
  const receivedPartial = !!(logs && "items" in logs.received && logs.received.partial);
  const sentPartial = !!(logs && "items" in logs.sent && logs.sent.partial);
  // 役割に許されない区画は出さない（読めたあとに分かる）。区画が 3 つのときは、最後の区画を 2 列にまたがせる
  const showReceived = !(logs && "forbidden" in logs.received);
  const showSent = !(logs && "forbidden" in logs.sent);
  const sections = 2 + (showReceived ? 1 : 0) + (showSent ? 1 : 0);
  const span = "min-[761px]:col-span-2";
  return (
    <div
      role="region"
      aria-label={`${id} の詳細`}
      data-testid="modality-detail"
      className="grid grid-cols-1 gap-x-4 gap-y-3 border-t border-border bg-background p-3 min-[761px]:grid-cols-2"
    >
      <Sec title="設定">
        <Kv rows={setting} />
      </Sec>
      <Sec title="接続確認">
        <Kv rows={[["最後の接続確認", <EchoState key="echo" r={result} live={false} />]]} />
        <div className="mt-3 flex">
          <ActionButton type="button" size="sm" variant="outline" pending={result === "busy"} onClick={onEcho} data-testid="detail-echo">
            接続確認
          </ActionButton>
        </div>
      </Sec>
      {showReceived && (
        <Sec title="今日の受信" className={sections === 3 && !showSent ? span : undefined} flush>
          <RecentLog
            part={logs?.received}
            rows={received?.slice(0, RECENT).map((r, i) => ({
              key: `${r.study.studyInstanceUid ?? "row"}-${r.receivedAt ?? ""}-${i}`,
              at: r.receivedAt,
              study: r.study,
              status: <ReceivedState state={r.receiveState} />,
            }))}
            count={received?.length ?? 0}
            partial={receivedPartial}
            aside={receivedAside(received ?? [])}
            what="今日の受信"
            emptyText="今日の受信はありません。"
            label={`${id} の今日の受信`}
            timeZone={timeZone}
            href={`/received?aet=${aetQuery}`}
            linkText="受信一覧で全部見る"
            testId="detail-received"
          />
        </Sec>
      )}
      {showSent && (
        <Sec title="今日の送信" className={sections === 3 ? span : undefined} flush>
          <RecentLog
            part={logs?.sent}
            rows={sent?.slice(0, RECENT).map((s) => ({
              key: s.requestId ?? `${s.requestedAt}`,
              at: s.requestedAt,
              study: s.study,
              status: s.status ? <StatusBadge kind={SENT_STATUS_KINDS[s.status]}>{SENT_STATUS_LABELS[s.status]}</StatusBadge> : null,
            }))}
            count={sent?.length ?? 0}
            partial={sentPartial}
            aside={sentAside(sent ?? [])}
            what="今日の送信"
            emptyText="今日の送信はありません。"
            label={`${id} の今日の送信`}
            timeZone={timeZone}
            href={`/sent?aet=${aetQuery}`}
            linkText="送信一覧で全部見る"
            testId="detail-sent"
          />
        </Sec>
      )}
    </div>
  );
}

function ReceivedState({ state }: { state: ReceivedView["receiveState"] }) {
  if (state === "receiving") return <StatusBadge kind="wait">受信中</StatusBadge>;
  if (state === "received") return <StatusBadge kind="ok">受信完了</StatusBadge>;
  return <span className="text-label">—</span>;
}

/** 件数の行の右の補足（状態ごとの件数）。0 の状態は書かない */
function receivedAside(items: ReceivedView[]): string {
  const done = items.filter((r) => r.receiveState === "received").length;
  const running = items.filter((r) => r.receiveState === "receiving").length;
  return [done > 0 ? `受信完了 ${done}` : "", running > 0 ? `受信中 ${running}` : ""].filter(Boolean).join("・");
}

function sentAside(items: SentView[]): string {
  return SENT_STATUSES.map((s) => [s, items.filter((i) => i.status === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${SENT_STATUS_LABELS[s]} ${n}`)
    .join("・");
}

interface RecentRow {
  key: string;
  at: string | undefined;
  study: ReceivedView["study"];
  status: ReactNode;
}

/** 今日の記録の件数の行・新しい 5 件の表・全部見るリンク。件数が 0 でも枠と件数の行は出す */
function RecentLog({
  part,
  rows,
  count,
  partial,
  aside,
  what,
  emptyText,
  label,
  timeZone,
  href,
  linkText,
  testId,
}: {
  part: Part<unknown> | undefined;
  rows: RecentRow[] | undefined;
  count: number;
  /** 上限を超えた・期間の始まりまで遡れなかったため、件数は読めた範囲の分（「以上」と書く） */
  partial: boolean;
  aside: string;
  what: string;
  emptyText: string;
  label: string;
  timeZone: string;
  href: string;
  linkText: string;
  testId: string;
}) {
  const failed = part && "failed" in part ? part.failed : null;
  const loading = part === undefined;
  return (
    <div data-testid={testId}>
      <div className="flex min-h-7 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
        <span className="text-sm text-value">
          今日 <b className="text-lg">{loading || failed ? "—" : count}</b> 件{partial && "以上"}
        </span>
        {aside && <span className="text-xs text-label">{aside}</span>}
      </div>
      {failed ? (
        <div className="px-3 pb-2">
          <NoticeBar kind="err">{failed || loadFailed(what)}</NoticeBar>
        </div>
      ) : (
        // 横にスクロールできる表は、キーボードでも動かせるよう tabindex を付ける（表の部品 Table と同じ）。枠は付けず、件数の行との間に線だけを引く
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        <div className="overflow-auto border-t border-border" role="region" aria-label={label} tabIndex={0}>
          <table className="w-full border-collapse text-sm">
            <thead className="bg-surface text-left text-xs text-label">
              <tr className="border-b border-border [&>*:first-child]:pl-3 [&>*:last-child]:pr-3">
                <th className="h-7 px-2 py-0 font-normal">日時</th>
                <th className="h-7 px-2 py-0 font-normal">患者ID</th>
                <th className="h-7 px-2 py-0 font-normal">氏名</th>
                <th className="h-7 px-2 py-0 font-normal">モダリティ・検査名</th>
                <th className="h-7 px-2 py-0 font-normal">状態</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-2 py-3 text-center" data-testid={`${testId}-none`}>
                    <b className="block text-value">{emptyText}</b>
                    <span className="text-label">過去の分は、全部見るリンクから期間を変えてください。</span>
                  </td>
                </tr>
              )}
              {rows?.map((r) => (
                <tr key={r.key} className="h-7 border-b border-border [&>*:first-child]:pl-3 [&>*:last-child]:pr-3" data-testid={`${testId}-row`}>
                  <td className="px-2 py-0 whitespace-nowrap tabular-nums">{(formatDateTimeIn(r.at, timeZone).split(" ")[1] ?? "") || "—"}</td>
                  <td className="px-2 py-0 font-mono">{r.study.patientId || "—"}</td>
                  <td className="px-2 py-0 font-bold text-value">{r.study.patientName || "—"}</td>
                  <td className="px-2 py-0">
                    <span className="inline-flex items-center gap-1.5">
                      {r.study.modalities?.map((m) => <ModalityMark key={m} modality={m} />)}
                      {r.study.studyDescription}
                    </span>
                  </td>
                  <td className="px-2 py-0">{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="px-3 py-2">
        <Link href={href} className="inline-block text-link underline-offset-2 hover:underline" data-testid={`${testId}-all`}>
          {linkText}
        </Link>
      </div>
    </div>
  );
}
