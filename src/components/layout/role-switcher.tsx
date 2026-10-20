"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ROLE_LABELS, ROLES, type Role } from "@/lib/auth/roles";
import { cn } from "@/lib/utils";

// 検証モードの役割の切り替え（管理者・医師・技師・閲覧）。切り替えは BFF が監査の記録に残す。
export function RoleSwitcher({ current }: { current: Role }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  async function switchTo(role: Role) {
    setError(null);
    const res = await fetch("/api/dev/role", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      setError("切り替えに失敗しました");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div role="group" aria-label="役割" className="flex items-center gap-1">
      <span>役割：</span>
      {ROLES.map((role) => (
        <Button
          key={role}
          type="button"
          size="sm"
          variant="outline"
          aria-pressed={role === current}
          disabled={pending}
          onClick={() => void switchTo(role)}
          // 帯の地の上なので、hover・押している間も帯の色で変える（共通の hover の地では字が読めない）
          className={cn(
            "border-dev-band-foreground/40 text-dev-band-foreground not-disabled:hover:border-dev-band-foreground not-disabled:hover:bg-dev-band-foreground/20 not-disabled:active:bg-dev-band-foreground/30",
            role === current &&
              "bg-dev-band-foreground font-bold text-dev-band not-disabled:hover:bg-dev-band-foreground not-disabled:active:bg-dev-band-foreground",
          )}
        >
          {ROLE_LABELS[role]}
        </Button>
      ))}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
