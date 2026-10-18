"use client";

import { ChevronDown, Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { ScreenInfo } from "@/components/studies/screen-info";
import { getJson } from "@/lib/client/api";
import { errorText, postJson } from "@/lib/client/post-json";
import { VIEWER_LABELS, isViewerId, type ViewerId } from "@/lib/viewers";

// 行の [▶ 開く | ▾]（docs/spec.md の 3.2）。▶ は既定のビューアで、▾ はビューアを選んで、別のタブで開く。
// 開くのは BFF の /api/viewers/open を通す（どの検査をどのビューアで開いたかを監査の記録に残してから移す）。
// ▾ からは「この検査は次から○○」と覚えさせ、DICOMweb の URL（このアプリの監査の外）をコピーできる。

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
  screen,
  onChanged,
  seriesLabel,
}: {
  studyUid: string;
  defaultViewer: string | null | undefined;
  rememberedViewer: string | null | undefined;
  screen: ScreenInfo;
  onChanged: () => void;
  /** 詳細のパネルのシリーズから開くときの、ボタンの名前の補い */
  seriesLabel?: string;
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
    const result = await postJson(`/api/studies/${encodeURIComponent(studyUid)}/viewer`, { viewer }, screen.csrfToken);
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
    <div ref={root} className="relative inline-flex flex-col items-end gap-1" data-row-control>
      <div className="inline-flex">
        <Button
          type="button"
          size="sm"
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
          size="sm"
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
        <span className="text-xs text-label" data-testid="remembered-viewer">
          既定: {VIEWER_LABELS[rememberedViewer]}
        </span>
      )}
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute top-8 right-0 z-30 min-w-56 rounded-md border border-border bg-background py-1 text-left shadow-md"
        >
          {openers.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-1.5 text-left hover:bg-muted"
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
                  className="block w-full px-3 py-1.5 text-left hover:bg-muted"
                  onClick={() => void remember(v.id)}
                >
                  この検査は次から {v.label}
                </button>
              ))}
              {rememberedViewer && (
                <button
                  type="button"
                  role="menuitem"
                  className="block w-full px-3 py-1.5 text-left hover:bg-muted"
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
                className="block w-full px-3 py-1.5 text-left hover:bg-muted"
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
        <span role="status" className="text-xs text-label">
          {message}
        </span>
      )}
    </div>
  );
}
