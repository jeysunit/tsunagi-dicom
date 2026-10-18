import { z } from "zod";
import { checkedState, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { assertRecentReauth, updateUser } from "@/lib/auth/local-auth";
import { ROLES } from "@/lib/auth/roles";
import { authContext, requireSession } from "@/lib/auth/session";

// 利用者を変える（役割・止める／戻す・TOTP のやり直し・ログインの一時停止の解除）。管理者だけ。
// 変更はそれぞれ監査の記録に残す（role_change・user_status_change・mfa_reset・login_unlock）。

const Body = z
  .object({
    role: z.enum(ROLES).optional(),
    status: z.enum(["active", "disabled"]).optional(),
    resetTotp: z.literal(true).optional(),
    clearLoginLock: z.literal(true).optional(),
  })
  .strict();

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    await checkedState(request);
    const session = await requireSession("user.manage");
    const { id } = await params;
    const ctx = await authContext();
    // 大事な操作：直前に本人の確かめ（/api/auth/reauth）が要る
    assertRecentReauth(ctx, session.local!.row);
    const change = await readJson(request, Body);
    const user = await updateUser(ctx, id, change, { actorId: session.actorId, actorRole: session.role });
    return Response.json({ id: user.id, role: user.role, status: user.status });
  } catch (error) {
    return errorResponse(error);
  }
}
