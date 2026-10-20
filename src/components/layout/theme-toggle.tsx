"use client";

import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/client/post-json";
import type { Theme } from "@/lib/preferences";
import { cn } from "@/lib/utils";

/** 頁の地を替える（<html data-theme>） */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

// 明るい地と暗い地の切り替え（docs/spec.md の 2）。選んだ地は利用者ごとに BFF が覚える。
// 「表示」の2つのボタンの並び（ライト・ダーク）。押している側が今の地（1つのボタンでは、今の状態か切り替え先かが分からなかった）。
export function ThemeToggle({ initial, csrfToken }: { initial: Theme; csrfToken?: string }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [error, setError] = useState(false);

  async function choose(next: Theme) {
    if (next === theme) return;
    const before = theme;
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

  const option = (value: Theme, label: string, icon: React.ReactNode) => (
    <Button
      type="button"
      variant="outline"
      size="sm"
      aria-pressed={theme === value}
      data-testid={`theme-${value}`}
      onClick={() => void choose(value)}
      className={cn(
        "rounded-none first:rounded-l-md last:rounded-r-md",
        theme === value && "bg-primary text-primary-foreground not-disabled:hover:bg-primary-hover not-disabled:active:bg-primary-active",
      )}
    >
      {icon}
      {label}
    </Button>
  );

  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-label" id="theme-label">
        表示
      </span>
      <span role="group" aria-labelledby="theme-label" className="inline-flex -space-x-px" data-testid="theme-toggle">
        {option("light", "ライト", <Sun aria-hidden />)}
        {option("dark", "ダーク", <Moon aria-hidden />)}
      </span>
      {error && (
        <span role="alert" className="text-xs text-danger">
          表示の設定を保存できませんでした
        </span>
      )}
    </span>
  );
}
