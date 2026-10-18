import { checkedState, clearSessionCookie } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { logout } from "@/lib/auth/local-auth";
import { authContext } from "@/lib/auth/session";

// ログアウト。画面のロック中・ログインの途中でもできる。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    const target =
      state.kind === "pending" ? { row: state.row, user: state.user } : state.kind === "anonymous" ? undefined : state.session.local;
    if (target) await logout(await authContext(), target.row, target.user);
    await clearSessionCookie();
    return Response.json({ next: "/login" });
  } catch (error) {
    return errorResponse(error);
  }
}
