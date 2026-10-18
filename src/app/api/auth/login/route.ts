import { cookies } from "next/headers";
import { z } from "zod";
import { assertLocalMode, assertSameOrigin, readJson, setSessionCookie } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { login } from "@/lib/auth/local-auth";
import { MAX_PASSWORD_LENGTH } from "@/lib/auth/password-policy";
import { authContext, SESSION_COOKIE } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

const Body = z.object({
  username: z.string().max(64),
  // 長すぎるものは argon2 に回さない（規則の上限の4倍まで受け、合わないものとして扱う）
  password: z.string().max(MAX_PASSWORD_LENGTH * 4),
});

// ログイン（利用者名とパスワード）。合えば、TOTP の入力・登録・パスワードの変更の段か、ログインしたセッションを開く。
// まだセッションが無いので、CSRF の対策は SameSite と Origin の確かめ。
// ログインし直したら、このブラウザがいま持っているセッション（cookie の token）を消す。
// パスワードの確かめが混んでいれば 503 と Retry-After（src/lib/auth/hash-limiter.ts）。
export async function POST(request: Request) {
  try {
    assertLocalMode();
    assertSameOrigin(request);
    const body = await readJson(request, Body);
    const previous = (await cookies()).get(SESSION_COOKIE)?.value;
    const result = await login(await authContext(), body.username.trim(), body.password, previous);
    await setSessionCookie(result.token, result.expiresAt);
    return Response.json({ next: STAGE_PATHS[result.stage] });
  } catch (error) {
    return errorResponse(error);
  }
}
