import { FlaskConical } from "lucide-react";
import { RoleSwitcher } from "@/components/layout/role-switcher";
import type { Role } from "@/lib/auth/roles";

// 検証モード（AUTH_MODE=dev）の帯。画面の上に出し続ける（docs/spec.md の 4）。
export function DevModeBand({ role, allowWrite }: { role: Role; allowWrite: boolean }) {
  return (
    <div
      role="status"
      data-testid="dev-mode-band"
      className="sticky top-0 z-50 flex flex-wrap items-center gap-x-4 gap-y-1 bg-dev-band px-4 py-1.5 text-dev-band-foreground"
    >
      <span className="flex items-center gap-1.5 font-bold">
        <FlaskConical aria-hidden className="size-4" />
        検証モード
      </span>
      <RoleSwitcher current={role} />
      <span className="text-xs">{allowWrite ? "書き込みを許している（DEV_ALLOW_WRITE=true）" : "書き込みは止めている"}</span>
    </div>
  );
}
