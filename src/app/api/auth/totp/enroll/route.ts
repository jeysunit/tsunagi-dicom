import { z } from "zod";
import { checkedState, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { confirmEnrollment } from "@/lib/auth/local-auth";
import { authContext, AuthError } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

const Body = z.object({ code: z.string().max(16) });

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
    const { code } = await readJson(request, Body);
    const stage = await confirmEnrollment(await authContext(), target.row, target.user, code);
    return Response.json({ next: STAGE_PATHS[stage] });
  } catch (error) {
    return errorResponse(error);
  }
}
