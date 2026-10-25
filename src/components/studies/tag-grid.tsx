"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  EMPTY_SELECTION,
  pickRow,
  selectAll,
  selectedIndexes,
  type PickModifiers,
  type RowSelection,
} from "@/lib/client/row-selection";
import { tagRowsText, type CopyableTagRow } from "@/lib/client/tag-copy";
import { cn } from "@/lib/utils";

// DICOM タグの表（タグ・タグ名・VR・値）の本体。行を選べる（docs/design-system/components.md の「タグの表」）：
// - 選び方：クリックで 1 行、Shift で範囲、Ctrl（Mac は Cmd）で足す・外す。矢印のキーで動いた行を選び（Shift で範囲）、
//   Space で足す・外す、Ctrl／Cmd + A で全部、Esc で外す。選んだ行は `selected` の地と左 3px の線（一覧の表と同じ）。
// - 写す：選んだ行の上で右クリック（またはメニューのキー・Shift + F10）で「タグとタグ値をコピー」、Ctrl／Cmd + C でも同じ中身を写す。
//   中身は 1 行 1 タグで、タグ・タグ名・VR・値のタブ区切り（src/lib/client/tag-copy.ts）。
// - 浮くメニューは標準の popover に任せる（暗幕・Esc で閉じる動きを自前で書かない）。
// 行を読み直したら（表が出し直されたら）選びは捨てる。TagTable が読み込み中は表を出さないので、そのたびにここが作り直される。

interface MenuPosition {
  x: number;
  y: number;
}

const MENU_WIDTH = 224;
const NOTICE_MS = 2500;

export function TagGrid({ rows }: { rows: readonly CopyableTagRow[] }) {
  const [selection, setSelection] = useState<RowSelection>(EMPTY_SELECTION);
  const [active, setActive] = useState(0);
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const [notice, setNotice] = useState("");
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);

  const picked = selectedIndexes(selection).flatMap((i) => (rows[i] ? [rows[i]] : []));

  // 知らせは一定の時間で消す
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 浮くメニューを開く：標準の popover で最前面に出し、項目へフォーカスを移す
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) return;
    el.showPopover();
    el.querySelector<HTMLElement>("[role=menuitem]")?.focus();
  }, [menu]);

  function choose(index: number, modifiers: PickModifiers = {}) {
    setSelection((current) => pickRow(current, index, modifiers));
    setActive(index);
  }

  function focusRow(index: number) {
    const el = rowRefs.current[index];
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest" });
  }

  function openMenu(position: MenuPosition) {
    setMenu({
      x: Math.max(0, Math.min(position.x, window.innerWidth - MENU_WIDTH)),
      y: Math.max(0, Math.min(position.y, window.innerHeight - 56)),
    });
  }

  function announce(count: number, ok: boolean) {
    setNotice(ok ? `${count} 行をコピーしました` : "コピーできませんでした");
  }

  /** メニューの「タグとタグ値をコピー」：選んだ行を写す（選びが空なら動いている行） */
  async function copyFromMenu() {
    const rowsToCopy = picked.length > 0 ? picked : rows[active] ? [rows[active]] : [];
    setMenu(null);
    menuRef.current?.hidePopover();
    focusRow(active);
    try {
      await navigator.clipboard.writeText(tagRowsText(rowsToCopy));
      announce(rowsToCopy.length, true);
    } catch {
      announce(rowsToCopy.length, false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTableRowElement>, index: number) {
    if (e.target !== e.currentTarget) return;
    const mod = e.ctrlKey || e.metaKey;
    const move = (to: number) => {
      e.preventDefault();
      const next = Math.min(rows.length - 1, Math.max(0, to));
      choose(next, { range: e.shiftKey });
      focusRow(next);
    };
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(rows.length - 1);
    else if (e.key === " ") {
      e.preventDefault();
      choose(index, { toggle: true });
    } else if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelection(selectAll(rows.length, index));
    } else if (e.key === "Escape") {
      setSelection(EMPTY_SELECTION);
    } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault();
      if (!selection.selected.has(index)) choose(index);
      const box = e.currentTarget.getBoundingClientRect();
      openMenu({ x: box.left + 24, y: box.bottom });
    }
  }

  return (
    <div
      onCopy={(e) => {
        // 文字を選んで写すとき（ドラッグで選んだ文字がある）は、ブラウザの動きに任せる
        const text = window.getSelection();
        if (picked.length === 0 || (text && !text.isCollapsed)) return;
        e.clipboardData.setData("text/plain", tagRowsText(picked));
        e.preventDefault();
        announce(picked.length, true);
      }}
    >
      <table className="w-full table-fixed text-xs" role="grid" aria-multiselectable="true" aria-label="DICOM タグ">
        <colgroup>
          <col className="w-[5.5rem]" />
          <col className="w-[7.5rem]" />
          <col className="w-[2.5rem]" />
          <col />
        </colgroup>
        <thead className="sticky top-0 bg-surface text-left text-label">
          <tr>
            <th scope="col" className="px-2 py-1 font-normal">
              タグ
            </th>
            <th scope="col" className="px-2 py-1 font-normal">
              タグ名
            </th>
            <th scope="col" className="px-2 py-1 font-normal">
              VR
            </th>
            <th scope="col" className="px-2 py-1 font-normal">
              値
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isPicked = selection.selected.has(i);
            return (
              <tr
                key={row.tag}
                ref={(el) => {
                  rowRefs.current[i] = el;
                }}
                className={cn(
                  "border-b border-border align-top last:border-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  isPicked ? "bg-selected font-bold [&>td:first-child]:shadow-[inset_3px_0_0_var(--color-ring)]" : "hover:bg-muted",
                )}
                data-tag={row.tag}
                data-selected={isPicked || undefined}
                aria-selected={isPicked}
                tabIndex={i === active ? 0 : -1}
                // Shift を押したクリックで、文字が範囲選択されないようにする
                onMouseDown={(e) => {
                  if (e.shiftKey) e.preventDefault();
                }}
                onClick={(e) => {
                  choose(i, { range: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
                  // Shift を押したクリックは mousedown を止めているので、フォーカスを自分で移す（続く矢印のキーが、押した行から動くように）
                  e.currentTarget.focus({ preventScroll: true });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  // 選んでいない行の上なら、その行だけを選んでからメニューを出す（選んだ行の上なら、選びを保つ）
                  if (!selection.selected.has(i)) choose(i);
                  else setActive(i);
                  openMenu({ x: e.clientX, y: e.clientY });
                }}
                onKeyDown={(e) => onKeyDown(e, i)}
              >
                <td className="px-2 py-1 font-mono whitespace-nowrap text-label">{row.tag}</td>
                <td className="px-2 py-1 break-words text-label">{row.name}</td>
                <td className="px-2 py-1 font-mono text-label">{row.vr}</td>
                <td className="px-2 py-1 break-all" data-testid="tag-value">
                  {row.value === null ? (
                    <span className="text-label">—</span>
                  ) : (
                    <>
                      {row.value}
                      {row.length != null && <span className="text-label">…（全 {row.length.toLocaleString("ja-JP")} 文字）</span>}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {/* 写せたかどうかを、画面と読み上げの両方に知らせる。表を下へスクロールしていても見えるよう、枠の下に貼る */}
      <p role="status" className={cn("sticky bottom-0 bg-surface px-2 py-1 text-xs text-label", !notice && "sr-only")} data-testid="tag-copy-notice">
        {notice}
      </p>
      {menu && (
        <div
          ref={menuRef}
          popover="auto"
          role="menu"
          aria-label="タグの操作"
          style={{ position: "fixed", inset: "auto", margin: 0, left: menu.x, top: menu.y, width: MENU_WIDTH }}
          className="rounded-md border border-border bg-background py-1 text-left text-sm text-foreground shadow-lg"
          data-testid="tag-menu"
          onToggle={(e) => {
            if (e.newState === "closed") {
              // フォーカスが行き場を失った（Esc・項目を押した）ときだけ、動いている行へ戻す。外の欄を押した・Tab で出たときは、その移り先を保つ
              const focused = document.activeElement;
              if (!focused || focused === document.body || e.currentTarget.contains(focused)) focusRow(active);
              setMenu(null);
            }
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="flex h-7 w-full items-center px-3 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
            data-testid="tag-copy"
            onClick={() => void copyFromMenu()}
          >
            タグとタグ値をコピー
          </button>
        </div>
      )}
    </div>
  );
}
