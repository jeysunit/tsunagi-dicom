"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ConnectionView } from "@/lib/connection-status";
import { formatDateTimeIn } from "@/lib/format/japanese-date";

// 上の帯の接続の状態（docs/design-system/parts.md の「上の帯」）。閉じているときは全体の状態の札を 1 つ（接続中・一部が接続不可）。
// 押すと標準の popover 属性で中身が開く（外を押す・Esc で閉じる。開け閉めは書かない）。
// 中身は画像サーバー・HL7 の受け口・接続先の直近の接続確認と、接続先の頁への道。状態は画面の API（/api/connection-status）から読む。
// 読むのは頁を開いたとき・1 分ごと（頁が見えている間）・開いたとき。相手に何も送らない。

const REFRESH_MS = 60_000;
const POPOVER_ID = "conn-pop";

type State = { kind: "loading" } | { kind: "error" } | { kind: "ready"; view: ConnectionView };

export function ConnStatus({ timeZone }: { timeZone: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
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
      popover.style.top = `${Math.round(rect.bottom + 4)}px`;
      popover.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
      void load();
    };
    popover.addEventListener("beforetoggle", onBeforeToggle);
    return () => popover.removeEventListener("beforetoggle", onBeforeToggle);
  }, [load]);

  const view = state.kind === "ready" ? state.view : undefined;
  const overall = state.kind === "error" ? "ng" : view?.overall;

  return (
    <span className="relative inline-flex" data-testid="conn-status">
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="sm"
        popoverTarget={POPOVER_ID}
        aria-label="接続の状態を開く"
        data-testid="conn-button"
        data-overall={overall ?? "loading"}
      >
        <span className="text-label">接続の状態</span>
        {overall === "ok" && <StatusBadge kind="confirmed">接続中</StatusBadge>}
        {overall === "ng" && <StatusBadge kind="failed">一部が接続不可</StatusBadge>}
        {overall === undefined && <StatusBadge kind="sending">確認中</StatusBadge>}
      </Button>
      <div
        ref={popoverRef}
        id={POPOVER_ID}
        popover="auto"
        role="group"
        aria-label="接続の状態"
        data-testid="conn-popover"
        className="fixed inset-auto m-0 w-80 max-w-[calc(100vw-1rem)] rounded-md border border-border bg-background p-3 text-sm text-foreground shadow-md"
      >
        <h3 className="mb-2 font-bold text-value">接続の状態</h3>
        {state.kind === "error" && <p>接続の状態を読み込めませんでした。時間をおいて、開き直してください。</p>}
        {view && (
          <dl className="space-y-2">
            {view.orthanc && (
              <Row name="画像サーバー（Orthanc）">
                {view.orthanc === "ok" ? <StatusBadge kind="confirmed">接続中</StatusBadge> : <StatusBadge kind="failed">失敗</StatusBadge>}
              </Row>
            )}
            {view.hl7 && (
              <Row name="HL7 の受け口">
                {view.hl7 === "listen" ? <StatusBadge kind="done">待ち受け中</StatusBadge> : <StatusBadge kind="notice">未設定</StatusBadge>}
              </Row>
            )}
            {view.modalities?.map((m) => (
              <Row key={m.id} name={m.aet ? `${m.id}（AE: ${m.aet}）` : m.id}>
                {m.result === "ok" && <StatusBadge kind="confirmed">成功</StatusBadge>}
                {m.result === "ng" && <StatusBadge kind="failed">失敗</StatusBadge>}
                {m.result === null && <span className="text-label">—</span>}
                {m.at && <span className="text-xs text-label">{formatDateTimeIn(m.at, timeZone)}</span>}
              </Row>
            ))}
          </dl>
        )}
        {view?.mock && (
          <p className="mt-2 text-xs text-label" data-testid="backend-mock">
            バックエンド：モック
          </p>
        )}
        <div className="mt-3 flex justify-end">
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

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <dt className="text-label">{name}</dt>
      <dd className="flex items-center gap-2 font-bold text-value">{children}</dd>
    </div>
  );
}
