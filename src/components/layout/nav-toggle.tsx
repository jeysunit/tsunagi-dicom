"use client";

import { PanelLeft, PanelLeftClose } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const KEY = "tsunagi-nav";

/** 左のナビの幅を替える（<body data-nav="collapsed">。docs/design-system/menu.md の「ナビの開閉」） */
function apply(collapsed: boolean) {
  if (collapsed) document.body.dataset.nav = "collapsed";
  else delete document.body.dataset.nav;
}

/** 本文の幅が足りない画面（768px 未満。390px の電話など）。ナビを閉じた形で始め、ここでの開閉は覚えない */
const NARROW = "(max-width: 767px)";

// 上の帯の左端のボタン。閉じた状態はこのブラウザに覚える（使えないブラウザでは覚えず、開いた状態で始める）。
// 狭い画面では、覚えた状態にかかわらず閉じた形で始める（開いたナビ 208px が本文の幅を取り、一覧が 120px ほどになるため）。
export function NavToggle() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let collapsed = window.matchMedia?.(NARROW).matches ?? false;
    try {
      if (window.localStorage.getItem(KEY) === "collapsed") collapsed = true;
    } catch {
      // 使えないブラウザでは、覚えない
    }
    if (collapsed) {
      apply(true);
      // 覚えた状態を、描いた後に反映する（描く前は開いた状態。サーバーの描画とそろえる）
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setOpen(false);
    }
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    apply(!next);
    // 狭い画面での開閉は覚えない（広い画面に戻ったときの形を変えない）
    if (window.matchMedia?.(NARROW).matches) return;
    try {
      if (next) window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, "collapsed");
    } catch {
      // 使えないブラウザでは、覚えない
    }
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-expanded={open}
      aria-label={open ? "ナビを閉じる" : "ナビを開く"}
      title={open ? "ナビを閉じる" : "ナビを開く"}
      onClick={toggle}
      data-testid="nav-toggle"
    >
      {open ? <PanelLeftClose aria-hidden /> : <PanelLeft aria-hidden />}
    </Button>
  );
}
