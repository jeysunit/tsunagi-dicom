import "server-only";
import { redirect } from "next/navigation";
import { can, type Permission } from "@/lib/auth/roles";
import { getAuthState, type Session } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

export type PageAccess = { kind: "ok"; session: Session } | { kind: "locked" } | { kind: "forbidden" };

/**
 * 頁を描く前の確かめ。ログインしていなければログインの頁へ、ログインの途中ならその段の頁へ移す。
 * 画面のロック中は locked（頁は中身を描かない。ロックの画面は src/app/layout.tsx が出す）。
 */
export async function pageAccess(permission?: Permission): Promise<PageAccess> {
  const state = await getAuthState();
  if (state.kind === "anonymous") redirect("/login");
  if (state.kind === "pending") redirect(STAGE_PATHS[state.stage]);
  if (state.kind === "locked") return { kind: "locked" };
  if (permission && !can(state.session.role, permission)) return { kind: "forbidden" };
  return { kind: "ok", session: state.session };
}
