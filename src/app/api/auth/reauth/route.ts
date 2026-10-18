import { z } from "zod";
import { checkedState, clearSessionCookie, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { AuthFailure, REAUTH_MINUTES, reauthenticate } from "@/lib/auth/local-auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { authContext, AuthError } from "@/lib/auth/session";

const Body = z.object({
  password: z.string().max(MAX_PASSWORD_LENGTH * 4),
  code: z.string().max(16).optional(),
});

// 大事な操作（利用者の管理）の前の、もう一度の本人の確かめ（パスワードと、登録していれば TOTP）。
// 通れば REAUTH_MINUTES 分の間、大事な操作ができる。失敗はログインの失敗と同じに数える。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    if (state.kind === "locked") throw new AuthError(423, "画面をロックしている。パスワードで解く");
    const local = state.kind === "active" ? state.session.local : undefined;
    if (!local) throw new AuthError(401, "ログインしていない");
    const body = await readJson(request, Body);
    try {
      await reauthenticate(await authContext(), local.row, local.user, body);
    } catch (error) {
      if (error instanceof AuthFailure && error.problems.includes("locked")) {
        await clearSessionCookie();
        return Response.json({ error: error.message, next: "/login" }, { status: 401 });
      }
      throw error;
    }
    return Response.json({ ok: true, minutes: REAUTH_MINUTES });
  } catch (error) {
    return errorResponse(error);
  }
}
