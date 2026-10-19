"use client";

import { ChevronDown, Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
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
  /** 一覧の 1 行に収める形：ボタンは 24px、覚えたビューアの印と知らせは同じ行の左に並べる（長ければ `…` で切る） */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const openers = screen.viewers.filter((v) => v.kind === "open");
  const copier = screen.viewers.find((v) => v.kind === "copy");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function remember(viewer: ViewerId | null) {
    setOpen(false);
    const result = await postJson(
      `/api/studies/${encodeURIComponent(studyUid)}/viewer`,
      { viewer, version: viewerVersion ?? 0 },
      screen.csrfToken,
    );
    if (result.status === 409) {
      setMessage("ほかの利用者が先に変えたので、読み直した。もう一度選ぶ");
      onChanged();
      return;
    }
    setMessage(result.ok ? null : errorText(result));
    if (result.ok) onChanged();
  }

  async function copyDicomweb() {
    setOpen(false);
    try {
      const { url } = await getJson<{ url: string }>(openUrl(studyUid, "dicomweb"));
      await navigator.clipboard.writeText(url);
      setMessage("DICOMweb の URL をコピーした（このアプリの監査の外）");
    } catch {
      setMessage("コピーできなかった");
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
          title={defaultViewer ? undefined : "ビューアが設定されていない"}
          aria-label={`${seriesLabel ?? ""}${label ?? "既定のビューア"}で開く`}
          data-testid="open-default"
          onClick={() => openInViewer(studyUid, defaultViewer)}
        >
          <Play aria-hidden />
          開く
        </Button>
        <Button
          type="button"
          size={compact ? "xs" : "sm"}
          className="rounded-l-none border-l border-primary-foreground/30 px-1.5"
          aria-label="ビューアを選ぶ"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          disabled={screen.viewers.length === 0}
          data-testid="open-menu"
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDown aria-hidden />
        </Button>
      </div>
      {rememberedViewer && isViewerId(rememberedViewer) && (
        <span className="min-w-0 truncate text-xs text-label" data-testid="remembered-viewer">
          既定: {VIEWER_LABELS[rememberedViewer]}
        </span>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          className={cn(
            "absolute right-0 z-30 min-w-56 rounded-md border border-border bg-background py-1 text-left shadow-md",
            compact ? "top-7" : "top-8",
          )}
        >
          {openers.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              onClick={() => {
                setOpen(false);
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
                  className={MENU_ITEM}
                  onClick={() => void remember(v.id)}
                >
                  この検査は次から {v.label}
                </button>
              ))}
              {rememberedViewer && (
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM}
                  onClick={() => void remember(null)}
                >
                  覚えを消す（モダリティの既定で開く）
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
                className={MENU_ITEM}
                onClick={() => void copyDicomweb()}
              >
                DICOMweb の URL をコピー
                <span className="block text-xs text-label">このアプリの監査の外（研究の道具に渡す）</span>
              </button>
            </>
          )}
        </div>
      )}
      {message && (
        <span role="status" title={message} className={cn("text-xs text-label", compact && "min-w-0 truncate")}>
          {message}
        </span>
      )}
    </div>
  );
}
