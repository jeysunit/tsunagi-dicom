"use client";

import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { postJson } from "@/lib/client/post-json";

export function LogoutButton({ csrfToken }: { csrfToken: string }) {
  async function onClick() {
    await postJson("/api/auth/logout", {}, csrfToken);
    window.location.assign("/login");
  }
  return (
    <Button type="button" size="sm" variant="outline" onClick={() => void onClick()}>
      <LogOut aria-hidden />
      ログアウト
    </Button>
  );
}
