"use client";

import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/client/post-json";
import type { Theme } from "@/lib/preferences";

/** 頁の地を替える（<html data-theme>） */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

// 明るい地と暗い地の切り替え（docs/spec.md の 2）。絵の押しボタン 1 つで、押すたびに替える。
// 絵は今の地（明るい地は太陽、暗い地は月）。押している状態（aria-pressed）が暗い地。選んだ地は利用者ごとに BFF が覚える。
export function ThemeToggle({ initial, csrfToken }: { initial: Theme; csrfToken?: string }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [error, setError] = useState(false);

  async function toggle() {
    const before = theme;
    const next: Theme = theme === "dark" ? "light" : "dark";
    setError(false);
    setTheme(next);
    applyTheme(next);
    const result = await postJson("/api/preferences/theme", { theme: next }, csrfToken);
    if (!result.ok) {
      setTheme(before);
      applyTheme(before);
      setError(true);
    }
  }

  return (
    <span className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label="表示をライトとダークで切り替える"
        aria-pressed={theme === "dark"}
        data-testid="theme-toggle"
        onClick={() => void toggle()}
        className="w-7 px-0"
      >
        {theme === "dark" ? <Moon aria-hidden /> : <Sun aria-hidden />}
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          表示の設定を保存できませんでした
        </span>
      )}
    </span>
  );
}
