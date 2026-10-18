import { checkedState } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { touchSession } from "@/lib/auth/local-auth";
import { authContext } from "@/lib/auth/session";

// 画面で操作があったことを知らせる（サーバーの側の画面のロックの時間を数え直す）。
// 数え直すのはこの道だけ（画像の取得・画面の API などの裏の要求では数え直さない）。
export async function POST(request: Request) {
  try {
    const state = await checkedState(request);
    if (state.kind === "active" && state.session.local) await touchSession(await authContext(), state.session.local.row);
    return Response.json({ locked: state.kind === "locked" }, { status: state.kind === "locked" ? 423 : 200 });
  } catch (error) {
    return errorResponse(error);
  }
}
