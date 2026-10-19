import { z } from "zod";
import { checkedState, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { reauthenticate } from "@/lib/auth/local-auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { authContext, AuthError } from "@/lib/auth/session";

const Body = z.object({
  password: z.string().max(MAX_PASSWORD_LENGTH * 4),
  code: z.string().max(16).optional(),
});

// 大事な操作（利用者の管理）の前の、もう一度の本人の確かめ（パスワードと、登録していれば TOTP）。
// 通れば設定の REAUTH_MINUTES 分の間、大事な操作ができる。失敗はログインの失敗と同じに数える。
// ログインの一時停止の間は断る（401、problems に locked）。ログインし終えたセッションは閉じない
// （2026-10-18 に承認者が決めた。docs/spec.md の 3.6）。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    if (state.kind === "locked") throw new AuthError(423, "画面ロック中です。パスワードでロックを解除してください");
    const local = state.kind === "active" ? state.session.local : undefined;
    if (!local) throw new AuthError(401, "ログインしていません。再度ログインしてください");
    const body = await readJson(request, Body);
    const ctx = await authContext();
    await reauthenticate(ctx, local.row, local.user, body);
    return Response.json({ ok: true, minutes: ctx.settings.reauthMinutes });
  } catch (error) {
    return errorResponse(error);
  }
}
