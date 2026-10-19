import { z } from "zod";
import { checkedState, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { lockScreen } from "@/lib/auth/local-auth";
import { authContext, AuthError } from "@/lib/auth/session";

const Body = z.object({ reason: z.enum(["client_idle", "manual"]) });

// 画面のロック（第7.0版 12 遵守事項⑥）。画面の側が、操作の無い時間（SCREEN_LOCK_MINUTES）が続いたとき・
// 利用者が押したときに呼ぶ。ロックの間は、画面の API と中継が 423 を返す。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    if (state.kind === "pending") throw new AuthError(401, "ログインしていません。再度ログインしてください");
    const local = state.kind === "anonymous" ? undefined : state.session.local;
    if (!local) throw new AuthError(401, "ログインしていません。再度ログインしてください");
    const { reason } = await readJson(request, Body);
    await lockScreen(await authContext(), local.row, local.user, reason);
    return Response.json({ locked: true });
  } catch (error) {
    return errorResponse(error);
  }
}
