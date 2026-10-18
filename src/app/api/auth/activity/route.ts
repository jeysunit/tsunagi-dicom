import { checkedState } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";

// 画面で操作があったことを知らせる（サーバーの側の画面のロックの時間を数え直す）。
// 数え直しは、いまの状態を引くとき（src/lib/auth/session.ts の getAuthState）に行う。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    return Response.json({ locked: state.kind === "locked" }, { status: state.kind === "locked" ? 423 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
