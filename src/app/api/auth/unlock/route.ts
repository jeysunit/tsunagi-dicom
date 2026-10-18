import { z } from "zod";
import { checkedState, clearLockCookie, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { unlockScreen } from "@/lib/auth/local-auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { authContext, AuthError } from "@/lib/auth/session";

const Body = z.object({
  password: z.string().max(MAX_PASSWORD_LENGTH * 4),
  code: z.string().max(16).optional(),
});

// 画面のロックを解く（パスワードと、登録していれば TOTP）。失敗はログインの失敗と同じに数える。
// BFF の側がロックしていないとき（画面のロックの知らせが届かなかったときなど）も、いつも確かめる
// （画面の側だけがロックしているずれで、確かめずに中身を出させない。閉じる側に倒す）。
// ログインの一時停止の間は断る（401、problems に locked）。セッションはロックのまま残し、閉じない
// （2026-10-18 に承認者が決めた。一時停止が解けたら、同じセッションで解ける。docs/spec.md の 3.6）。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    const local = state.kind === "locked" || state.kind === "active" ? state.session.local : undefined;
    if (!local) throw new AuthError(401, "ログインしていない");
    const body = await readJson(request, Body);
    await unlockScreen(await authContext(), local.row, local.user, body);
    // 確かめが通ったので、画面が置いたロックの印（src/lib/auth/lock-cookie.ts）を消す
    await clearLockCookie();
    return Response.json({ locked: false });
  } catch (error) {
    return errorResponse(error);
  }
}
