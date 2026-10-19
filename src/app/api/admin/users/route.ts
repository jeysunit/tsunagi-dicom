import { z } from "zod";
import { assertLocalMode, checkedState, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { assertRecentReauth, createUser, listUsers } from "@/lib/auth/local-auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { ROLES } from "@/lib/auth/roles";
import { authContext, requireSession } from "@/lib/auth/session";

// 利用者の棚卸し（一覧と最後のログイン。第7.0版 14 遵守事項⑧）と、利用者を作る。管理者だけ。

export async function GET() {
  try {
    assertLocalMode();
    await requireSession("user.manage");
    return Response.json({ users: await listUsers(await authContext()) });
  } catch (error) {
    return errorResponse(error);
  }
}

const Body = z.object({
  username: z.string().max(64),
  displayName: z.string().max(100),
  role: z.enum(ROLES),
  password: z.string().max(MAX_PASSWORD_LENGTH * 4),
});

export async function POST(request: Request) {
  try {
    await checkedState(request);
    const session = await requireSession("user.manage");
    const ctx = await authContext();
    // 大事な操作：直前に本人の確かめ（/api/auth/reauth）が要る。利用者の管理は、TOTP を登録した管理者には TOTP まで求める
    // （パスワードとセッションだけで管理者を作り足させない。docs/spec.md の 3.6）
    assertRecentReauth(ctx, session.local!.row, session.local!.user, { requireTotp: true });
    const body = await readJson(request, Body);
    const user = await createUser(
      ctx,
      { ...body, username: body.username.trim(), mustChangePassword: true },
      { actorId: session.actorId, actorRole: session.role },
    );
    return Response.json({ id: user.id, username: user.username }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
