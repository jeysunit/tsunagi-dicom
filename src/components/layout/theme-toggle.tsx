"use client";

import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/client/post-json";
import type { Theme } from "@/lib/preferences";

// 明るい地と暗い地の切り替え（docs/spec.md の 2）。選んだ地は利用者ごとに BFF が覚える。
export function ThemeToggle({ initial, csrfToken }: { initial: Theme; csrfToken?: string }) {
  const [theme, setTheme] = useState<Theme>(initial);
  const [error, setError] = useState(false);
  const next: Theme = theme === "dark" ? "light" : "dark";

  async function toggle() {
    const before = theme;
    setError(false);
    setTheme(next);
    document.documentElement.dataset.theme = next;
    const result = await postJson("/api/preferences/theme", { theme: next }, csrfToken);
    if (!result.ok) {
      setTheme(before);
      document.documentElement.dataset.theme = before;
      setError(true);
    }
  }

  return (
    <span className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-pressed={theme === "dark"}
        data-testid="theme-toggle"
        onClick={() => void toggle()}
      >
        {theme === "dark" ? <Moon aria-hidden /> : <Sun aria-hidden />}
        暗い地
      </Button>
      {error && (
        <span role="alert" className="text-xs text-danger">
          地の色を覚えられなかった
        </span>
      )}
    </span>
  );
}
