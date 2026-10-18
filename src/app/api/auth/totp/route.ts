import { z } from "zod";
import { checkedState, clearSessionCookie, readJson, setSessionCookie } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { AuthFailure, submitTotp } from "@/lib/auth/local-auth";
import { authContext, AuthError } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

const Body = z.object({ code: z.string().max(16) });

// ログインの二要素（TOTP の確認の番号）。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    if (state.kind !== "pending") throw new AuthError(401, "ログインの途中ではない");
    const { code } = await readJson(request, Body);
    try {
      const result = await submitTotp(await authContext(), state.row, state.user, code);
      // ログインし終えたら、新しい token のセッションに替わっている
      if (result.rotated) await setSessionCookie(result.rotated.token, result.rotated.expiresAt);
      return Response.json({ next: STAGE_PATHS[result.stage] });
    } catch (error) {
      // 一時停止になったら、セッションは消えている
      if (error instanceof AuthFailure && error.problems.includes("locked")) await clearSessionCookie();
      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
