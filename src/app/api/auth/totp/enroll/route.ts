import { z } from "zod";
import { checkedState, readJson, setSessionCookie } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { confirmEnrollment } from "@/lib/auth/local-auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { authContext, AuthError } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

const Body = z.object({
  code: z.string().max(16),
  // 二要素が任意のときの、ログインした後の登録で、いまのパスワード（再認証）
  currentPassword: z.string().max(MAX_PASSWORD_LENGTH * 4).optional(),
});

// TOTP の登録を確かめる（登録の頁で出した秘密から、認証のアプリが出した番号）。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    const target =
      state.kind === "pending"
        ? { row: state.row, user: state.user }
        : state.kind === "active"
          ? state.session.local
          : undefined;
    if (!target) throw new AuthError(state.kind === "locked" ? 423 : 401, "TOTP を登録できる状態ではない");
    const { code, currentPassword } = await readJson(request, Body);
    const result = await confirmEnrollment(await authContext(), target.row, target.user, code, currentPassword);
    if (result.rotated) await setSessionCookie(result.rotated.token, result.rotated.expiresAt);
    return Response.json({ next: STAGE_PATHS[result.stage] });
  } catch (error) {
    return errorResponse(error);
  }
}
