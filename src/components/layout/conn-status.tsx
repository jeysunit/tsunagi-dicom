"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { postJson, type PostResult } from "@/lib/client/post-json";
import type { ConnectionView } from "@/lib/connection-status";
import { formatDateTimeIn } from "@/lib/format/japanese-date";
import { cn } from "@/lib/utils";

// 上の帯の接続の状態（docs/design-system/parts.md の「上の帯」。部品集の `.connbtn`・`.pop`）。
// 閉じているときは枠つき 32px のボタンの中に 「接続の状態」・全体の状態の札・シェブロン（開くと上向き）を左からこの順で置く。
// 全体の語は 5 つ（確認中・接続中・一部が接続不可・未確認・確認できません）だけ。ほかの語を作らない。
// 押すと標準の popover 属性で中身が開く（外を押す・Esc で閉じる。開け閉めは書かない）。ボタンに aria-label は付けない（見える文字が名前になる）。
// 640px 未満は「接続の状態」の文字を視覚的に隠す（読み上げの名前は残る）。1 分ごとに替わる札は読み上げない（aria-live を付けない）。
// 中身は画像サーバー・HL7 の受け口・接続先の直近の接続確認と、接続先の頁への道。状態は画面の API（/api/connection-status）から読む。
// 読むのは頁を開いたとき・1 分ごと（頁が見えている間）・開いたとき。この読み取りは相手に何も送らない。「接続確認」を押したときだけ、接続先に C-ECHO をかける（docs/spec.md の 3.3）。

const REFRESH_MS = 60_000;
const POPOVER_ID = "conn-pop";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; view: ConnectionView };

export function ConnStatus({ timeZone, csrfToken, canCheck = false }: { timeZone: string; csrfToken?: string; canCheck?: boolean }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  // 手で押した「接続確認」の結果の文。読み上げるのはこれだけ（1 分ごとに替わる札は読み上げない）
  const [report, setReport] = useState("");
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/connection-status", { credentials: "same-origin", cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { connection?: ConnectionView };
      setState({ kind: "ready", view: body.connection ?? {} });
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // 開く直前に、ボタンの真下（右端をそろえて）へ置き、状態を読み直す。popover は最前面の層に出るので、位置は自分で決める
  useEffect(() => {
    const popover = popoverRef.current;
    const button = buttonRef.current;
    if (!popover || !button) return;
    const onBeforeToggle = (event: Event) => {
      if ((event as ToggleEvent).newState !== "open") return;
      const rect = button.getBoundingClientRect();
      const top = Math.round(rect.bottom + 4);
      popover.style.top = `${top}px`;
      // 接続先が多いときや低い画面でも、末尾の結果と「接続先を開く」まで届くよう、残りの高さを上限にして中でスクロールする
      popover.style.maxHeight = `${Math.max(120, window.innerHeight - top - 8)}px`;
      popover.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
      void load();
    };
    // シェブロンの向きと aria-expanded は、開いているかどうかに合わせる（popover が閉じる道は外を押す・Esc・中の道の 3 つ）
    const onToggle = (event: Event) => setOpen((event as ToggleEvent).newState === "open");
    popover.addEventListener("beforetoggle", onBeforeToggle);
    popover.addEventListener("toggle", onToggle);
    return () => {
      popover.removeEventListener("beforetoggle", onBeforeToggle);
      popover.removeEventListener("toggle", onToggle);
    };
  }, [load]);

  const view = state.kind === "ready" ? state.view : undefined;
  const targets = view?.modalities?.map((m) => m.id) ?? [];

  // 登録された接続先すべてに、つながるかの確かめ（C-ECHO）をかけ、終わったら状態を読み直す。接続先の頁の「全部を接続確認」と同じ要求
  async function checkAll() {
    if (checking || targets.length === 0) return;
    setChecking(true);
    setReport("");
    try {
      const results = await Promise.all(targets.map((id) => postJson(`/api/modalities/${encodeURIComponent(id)}/echo`, {}, csrfToken)));
      await load();
      setReport(checkSummary(results));
    } finally {
      setChecking(false);
    }
  }
  // 読めなかった（401・423・通信の失敗）ときは、接続先が落ちているとは言えないので「一部が接続不可」にせず別の札にする。
  // 読めたが全体の状態が無い（この役割には全体の状態を返さない）ときは、確かめた結果を持たないので「未確認」
  const overall = state.kind === "error" ? "unknown" : state.kind === "loading" ? "loading" : (view?.overall ?? "unchecked");

  return (
    <span className="relative inline-flex" data-testid="conn-status">
      <button
        ref={buttonRef}
        type="button"
        popoverTarget={POPOVER_ID}
        aria-expanded={open}
        data-testid="conn-button"
        data-overall={overall}
        className="relative inline-flex h-8 items-center gap-1.5 rounded border border-border-input bg-background px-2 text-sm text-foreground hover:bg-hover aria-expanded:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span className="max-sm:sr-only">接続の状態</span>
        <OverallBadge overall={overall} />
        <ChevronDown aria-hidden className={cn("size-4 shrink-0 text-label transition-transform motion-reduce:transition-none", open && "rotate-180")} />
      </button>
      <div
        ref={popoverRef}
        id={POPOVER_ID}
        popover="auto"
        role="group"
        aria-label="接続の状態"
        data-testid="conn-popover"
        className="fixed inset-auto m-0 hidden w-[22.5rem] max-w-[calc(100vw-1rem)] flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-background px-4 py-3 text-left text-sm text-foreground shadow-lg [&:popover-open]:flex"
      >
        <h3 className="text-sm font-bold text-value">接続の状態</h3>
        {state.kind === "error" && <p>接続の状態を読み込めませんでした。時間をおいて、開き直してください。</p>}
        {view && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
            {view.orthanc && (
              <Row kind="画像サーバー" name="Orthanc">
                {view.orthanc === "ok" ? <StatusBadge kind="ok">接続中</StatusBadge> : <StatusBadge kind="ng">失敗</StatusBadge>}
              </Row>
            )}
            {view.hl7 && (
              <Row kind="受け口" name="HL7">
                {view.hl7 === "listen" ? <StatusBadge kind="listen">待ち受け中</StatusBadge> : <StatusBadge kind="note">未設定</StatusBadge>}
              </Row>
            )}
            {view.modalities?.map((m) => (
              <Row key={m.id} kind="送信先" name={m.id}>
                {m.result === "ok" && <StatusBadge kind="ok">成功</StatusBadge>}
                {m.result === "ng" && <StatusBadge kind="ng">失敗</StatusBadge>}
                {m.result === null && <StatusBadge kind="plan">未確認</StatusBadge>}
                {m.at && <span className="text-xs text-label">{formatDateTimeIn(m.at, timeZone)}</span>}
                {m.aet && <span className="text-xs text-label">AE: {m.aet}</span>}
              </Row>
            ))}
          </dl>
        )}
        {view?.mock && (
          <p className="text-xs text-label" data-testid="backend-mock">
            バックエンド：モック
          </p>
        )}
        <p className="sr-only" role="status" aria-live="polite" data-testid="conn-report">
          {report}
        </p>
        <div className="flex justify-end gap-2">
          {canCheck && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={targets.length === 0}
              aria-busy={checking || undefined}
              onClick={() => void checkAll()}
              data-testid="conn-check"
            >
              接続確認
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href="/modalities" onClick={() => popoverRef.current?.hidePopover()}>
              接続先を開く
            </Link>
          </Button>
        </div>
      </div>
    </span>
  );
}

/**
 * 手で押した「接続確認」の結果を読み上げる 1 文（parts.md の 3 つの型）。N は確かめた件数、M は失敗の件数。
 * どの接続先にも要求が届かなかった（権限・画面の期限切れ・通信の失敗で、全部が読めなかった）ときは「確かめられなかった」の型にする。
 * この製品は、状態を持たない相手（確かめる手段が無い相手）を接続確認に含めないので、全部を数える
 */
export function checkSummary(results: Pick<PostResult, "ok" | "data">[]): string {
  if (results.length === 0 || results.every((r) => !r.ok)) return "接続を確かめられませんでした。";
  const failed = results.filter((r) => !(r.ok && r.data.connected === true)).length;
  return failed === 0 ? `${results.length} 件すべてに接続できました。` : `${results.length} 件のうち ${failed} 件に接続できませんでした。`;
}

export type Overall ="loading" | "ok" | "ng" | "unchecked" | "unknown";

/** 全体の状態の札。語と data-k は parts.md の表の 5 つだけ */
export function OverallBadge({ overall }: { overall: Overall }) {
  switch (overall) {
    case "loading":
      return <StatusBadge kind="check">確認中</StatusBadge>;
    case "ok":
      return <StatusBadge kind="ok">接続中</StatusBadge>;
    case "ng":
      return <StatusBadge kind="ng">一部が接続不可</StatusBadge>;
    case "unchecked":
      return <StatusBadge kind="plan">未確認</StatusBadge>;
    case "unknown":
      return <StatusBadge kind="unknown">確認できません</StatusBadge>;
  }
}

/** 相手ごとの 種類（dt）・名前（太字）・札・時刻（dd） */
function Row({ kind, name, children }: { kind: string; name: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-xs leading-5 text-label">{kind}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 break-words">
        <b className="font-bold text-value">{name}</b>
        {children}
      </dd>
    </>
  );
}
