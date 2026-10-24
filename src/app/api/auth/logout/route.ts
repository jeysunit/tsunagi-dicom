import { checkedState, clearLockCookie, clearSessionCookie } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { logout } from "@/lib/auth/local-auth";
import { authContext } from "@/lib/auth/session";

// ログアウト。画面のロック中・ログインの途中でもできる。
// ロック中のログアウト（ロックの画面から。パスワードを知らない次の利用者が、ログインし直せるように）は、
// 監査の記録の detail に from: screen_lock を残す。ロック中かどうかは BFF の状態で決め、画面の申し出は使わない。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    const target =
      state.kind === "pending" ? { row: state.row, user: state.user } : state.kind === "anonymous" ? undefined : state.session.local;
    if (target) await logout(await authContext(), target.row, target.user, { fromScreenLock: state.kind === "locked" });
    await clearSessionCookie();
    await clearLockCookie();
    return Response.json({ next: "/login" });
  } catch (error) {
    return errorResponse(error);
  }
}
