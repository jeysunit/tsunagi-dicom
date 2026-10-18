import { z } from "zod";
import { checkedState, readJson, setSessionCookie } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { changePassword } from "@/lib/auth/local-auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { authContext, AuthError } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

const Body = z.object({
  currentPassword: z.string().max(MAX_PASSWORD_LENGTH * 4).optional(),
  // ログインした後の変更で、TOTP を登録していれば確認の番号（再認証）
  code: z.string().max(16).optional(),
  newPassword: z.string().max(MAX_PASSWORD_LENGTH * 4),
});

// 自分のパスワードの変更（定期的な変更は求めない。管理者が決めたパスワードは、最初のログインで変える）。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    const target =
      state.kind === "pending"
        ? { row: state.row, user: state.user }
        : state.kind === "active"
          ? state.session.local
          : undefined;
    if (!target) throw new AuthError(state.kind === "locked" ? 423 : 401, "パスワードを変えられる状態ではない");
    const body = await readJson(request, Body);
    const result = await changePassword(await authContext(), target.row, target.user, body);
    if (result.rotated) await setSessionCookie(result.rotated.token, result.rotated.expiresAt);
    return Response.json({ next: STAGE_PATHS[result.stage] });
  } catch (error) {
    return errorResponse(error);
  }
}
