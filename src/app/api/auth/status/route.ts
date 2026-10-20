import { assertLocalMode } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { getAuthState } from "@/lib/auth/session";

// いまのセッションの状態（画面のロックの確かめ用。src/components/auth/lock-guard.tsx が一定の間隔で聞く）。
// 200：ログインしていてロックしていない、423：画面のロック中、401：ログインしていない。
// 読むだけで、操作の時刻は数え直さない（サーバーの側のロックの時間を延ばさない）。患者の情報は返さない。
// 画面の側のロックの状態がずれても（ほかのタブの知らせの取りこぼし・時計のずれなど）、サーバーの側の
// ロックに合わせて閉じる側に倒すための道。
export async function GET() {
  try {
    assertLocalMode();
    const state = await getAuthState();
    if (state.kind === "locked") return Response.json({ locked: true }, { status: 423 });
    if (state.kind === "active") return Response.json({ locked: false });
    return Response.json({ error: "ログインしていません。再度ログインしてください" }, { status: 401 });
  } catch (error) {
    return errorResponse(error);
  }
}
