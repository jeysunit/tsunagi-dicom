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

// 上の帯の左端のボタン。閉じた状態はこのブラウザに覚える（使えないブラウザでは覚えず、開いた状態で始める）。
export function NavToggle() {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(KEY) === "collapsed") {
        apply(true);
        // 覚えた状態を、描いた後に反映する（描く前は開いた状態。サーバーの描画とそろえる）
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setOpen(false);
      }
    } catch {
      // 使えないブラウザでは、覚えない
    }
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    apply(!next);
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
