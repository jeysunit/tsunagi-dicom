"use client";

import { ChevronDown, Play } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import { VIEWER_LABELS, isViewerId, type ViewerId } from "@/lib/viewers";
import { cn } from "@/lib/utils";

// 行の [▶ 開く | ▾]（docs/spec.md の 3.2）。▶ は既定のビューアで、▾ はビューアを選んで、別のタブで開く。
// 開くのは BFF の /api/viewers/open を通す（どの検査をどのビューアで開いたかを監査の記録に残してから移す）。
// ▾ からは「この検査は次から○○」と覚えさせ、DICOMweb の URL（このアプリの監査の外）をコピーできる。

/** メニューの項目。hover・押している間・フォーカスで地を変える（docs/spec.md の 2.3） */
const MENU_ITEM =
  "block w-full px-3 py-1.5 text-left hover:bg-hover active:bg-pressed focus-visible:bg-hover focus-visible:outline-none";

export function openUrl(studyUid: string, viewer: string): string {
  return `/api/viewers/open?${new URLSearchParams({ study: studyUid, viewer })}`;
}

/** 既定のビューアで、別のタブで開く */
export function openInViewer(studyUid: string, viewer: string | null | undefined): void {
  if (!viewer) return;
  window.open(openUrl(studyUid, viewer), "_blank", "noopener");
}

export function ViewerMenu({
  studyUid,
  defaultViewer,
  rememberedViewer,
  viewerVersion,
  screen,
  onChanged,
  seriesLabel,
  compact = false,
}: {
  studyUid: string;
  defaultViewer: string | null | undefined;
  rememberedViewer: string | null | undefined;
  /** ビューアの覚えの版（覚えを変えるときに添える） */
  viewerVersion: number | undefined;
  screen: ScreenInfo;
  onChanged: () => void;
  /** 詳細のパネルのシリーズから開くときの、ボタンの名前の補い */
  seriesLabel?: string;
  /**
   * 一覧の 1 行に収める形：ボタンは 24px、覚えたビューアの印と知らせは同じ行の左に並べる（長ければ `…` で切る）。
   * この形では、2つのボタンを Tab の止まり先にしない（行に止まり、Enter で開く・Shift+F10 でメニュー。UX のレビューの M2）。
   * メニューをキーで閉じたら、行にフォーカスを戻す
   */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const openers = screen.viewers.filter((v) => v.kind === "open");
  const copier = screen.viewers.find((v) => v.kind === "copy");

  /** 閉じる。キーで閉じたときは ▾ にフォーカスを戻す（WAI-ARIA の menu の型） */
  const close = useCallback(
    (refocus = false) => {
      setOpen(false);
      setPlace(null);
      if (!refocus) return;
      const row = compact ? trigger.current?.closest<HTMLElement>("tr[data-study-uid]") : null;
      (row ?? trigger.current)?.focus();
    },
    [compact],
  );

  const items = () => [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];

  // メニューは body の直下に出し（詳細のパネル・一覧のスクロールの枠に切られないように。UX のレビューの M3）、
  // ▾ の右下にそろえて置く。下に入らなければ ▾ の上に出し、画面の左右からはみ出さない
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const at = trigger.current.getBoundingClientRect();
    const { offsetWidth: w, offsetHeight: h } = menu.current;
    const below = at.bottom + 4;
    const top = below + h <= window.innerHeight - 4 ? below : Math.max(4, at.top - 4 - h);
    const left = Math.min(Math.max(4, at.right - w), window.innerWidth - w - 4);
    setPlace({ top, left });
  }, [open]);

  // 置いた後に、最初の項目へフォーカスを移す
  useEffect(() => {
    if (open && place) items()[0]?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!root.current?.contains(t) && !menu.current?.contains(t)) close();
    };
    // 後ろが動いたら、置いた所がずれるので閉じる（メニューの中の動きは除く）
    const onScroll = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, close]);

  /** メニューの中のキー：上下の矢印・Home・End で項目を移り、Escape で閉じ、Tab で閉じて次へ進む */
  function onMenuKey(e: React.KeyboardEvent) {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      list[(i + list.length) % list.length]?.focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") {
      // 詳細のパネル・削除の画面の Escape まで届けない（メニューだけを閉じる）
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") close(true);
  }

  async function remember(viewer: ViewerId | null) {
    close(true);
    const result = await postJson(
      `/api/studies/${encodeURIComponent(studyUid)}/viewer`,
      { viewer, version: viewerVersion ?? 0 },
      screen.csrfToken,
    );
    if (result.status === 409) {
      setMessage("ほかのユーザーが先に変更しました。最新の状態を読み込みました");
      onChanged();
      return;
    }
    setMessage(result.ok ? null : errorText(result));
    if (result.ok) onChanged();
  }

  async function copyDicomweb() {
    close(true);
    try {
      const { url } = await getJson<{ url: string }>(openUrl(studyUid, "dicomweb"));
      await navigator.clipboard.writeText(url);
      setMessage("DICOMweb URL をコピーしました（操作ログの対象外）");
    } catch {
      setMessage("コピーできませんでした");
    }
  }

  const label = isViewerId(defaultViewer) ? VIEWER_LABELS[defaultViewer] : null;
  return (
    <div
      ref={root}
      className={cn("relative inline-flex items-end gap-1", compact ? "max-w-full flex-row-reverse items-center gap-1.5" : "flex-col")}
      data-row-control
    >
      <div className="inline-flex shrink-0">
        <Button
          type="button"
          size={compact ? "xs" : "sm"}
          className="rounded-r-none"
          disabled={!defaultViewer}
          title={defaultViewer ? undefined : "ビューア未設定"}
          tabIndex={compact ? -1 : undefined}
          aria-label={`${seriesLabel ?? ""}${label ?? "既定のビューア"}で開く`}
          data-testid="open-default"
          onClick={() => openInViewer(studyUid, defaultViewer)}
        >
          <Play aria-hidden />
          開く
        </Button>
        <Button
          ref={trigger}
          type="button"
          size={compact ? "xs" : "sm"}
          className="rounded-l-none border-l border-primary-foreground/30 px-1.5"
          aria-label="ビューアを選択"
          tabIndex={compact ? -1 : undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          disabled={screen.viewers.length === 0}
          data-testid="open-menu"
          onClick={() => (open ? close() : setOpen(true))}
          onKeyDown={(e) => {
            // 下の矢印でも開く（WAI-ARIA の menu button の型）
            if (e.key === "ArrowDown" && !open) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <ChevronDown aria-hidden />
        </Button>
      </div>
      {rememberedViewer && isViewerId(rememberedViewer) && (
        <span className="min-w-0 truncate text-xs text-label" data-testid="remembered-viewer">
          この検査: {VIEWER_LABELS[rememberedViewer]}
        </span>
      )}
      {open &&
        createPortal(
        <div
          ref={menu}
          id={menuId}
          role="menu"
          aria-label="ビューアを選択"
          tabIndex={-1}
          data-testid="viewer-menu"
          onKeyDown={onMenuKey}
          // 置く所を決めるまでは見せない（1 回だけ測ってから置く）
          style={place ? { top: place.top, left: place.left } : { top: 0, left: 0, visibility: "hidden" }}
          className="fixed z-50 min-w-56 rounded-md border border-border bg-background py-1 text-left text-sm text-foreground shadow-md"
        >
          {openers.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={MENU_ITEM}
              onClick={() => {
                close(true);
                openInViewer(studyUid, v.id);
              }}
            >
              {v.label}で開く
            </button>
          ))}
          {screen.can.rememberViewer && openers.length > 0 && (
            <>
              <div role="separator" className="my-1 border-t border-border" />
              {openers.map((v) => (
                <button
                  key={`remember-${v.id}`}
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={MENU_ITEM}
                  onClick={() => void remember(v.id)}
                >
                  この検査は {v.label} で開く
                </button>
              ))}
              {rememberedViewer && (
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={MENU_ITEM}
                  onClick={() => void remember(null)}
                >
                  記憶を解除（モダリティ別の設定に戻す）
                </button>
              )}
            </>
          )}
          {copier && (
            <>
              <div role="separator" className="my-1 border-t border-border" />
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={MENU_ITEM}
                onClick={() => void copyDicomweb()}
              >
                DICOMweb URL をコピー
                <span className="block text-xs text-label">操作ログの対象外です</span>
              </button>
            </>
          )}
        </div>,
          document.body,
        )}
      {message && (
        <span role="status" title={message} className={cn("text-xs text-label", compact && "min-w-0 truncate")}>
          {message}
        </span>
      )}
    </div>
  );
}
