import "server-only";
import { cookies } from "next/headers";
import type { z } from "zod";
import { readLimitedText } from "@/lib/api/body";
import { csrfMatches } from "@/lib/auth/local-auth";
import { AuthError, getAuthState, SESSION_COOKIE, type AuthState } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

// 状態を変える API（ログイン・利用者の管理など）の共通の確かめ。
// CSRF の対策は3つを重ねる：cookie の SameSite=Strict、Origin の確かめ、セッションごとの token（x-csrf-token）。

export class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "RequestError";
  }
}

/**
 * Origin が、この要求の宛先（Host）と同じか。ブラウザは状態を変える要求（POST など）にいつも Origin を付けるので、
 * 無い・違うものは断る
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** AUTH_MODE=local でなければ 404（検証モードには、この道は無い） */
export function assertLocalMode(): void {
  if (getConfig().auth.mode !== "local") throw new RequestError(404, "AUTH_MODE=local のときだけの道");
}

export function assertSameOrigin(request: Request): void {
  if (!isSameOrigin(request)) throw new RequestError(403, "別の場所からの要求は受けない（Origin が合わない）");
}

/** Origin と CSRF の token を確かめ、いまの認証の状態を返す */
export async function checkedState(request: Request): Promise<AuthState> {
  assertLocalMode();
  assertSameOrigin(request);
  const state = await getAuthState();
  const row = state.kind === "pending" ? state.row : state.kind === "anonymous" ? null : state.session.local?.row;
  if (!row) throw new AuthError(401, "ログインしていない");
  if (!csrfMatches(row.csrfToken, request.headers.get("x-csrf-token"))) {
    throw new RequestError(403, "要求の確かめの token（x-csrf-token）が合わない。頁を開き直す");
  }
  return state;
}

/** 本文の JSON を、決めた大きさまで読み、形を確かめる */
export async function readJson<T>(request: Request, schema: z.ZodType<T>, maxBytes = 4096): Promise<T> {
  const text = await readLimitedText(request, maxBytes);
  if (text === null) throw new RequestError(413, "本文が大きすぎる");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestError(400, "本文が JSON でない");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new RequestError(
      400,
      "本文の形が誤り",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(本文)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** ログインのセッションの cookie。いつも HttpOnly・Secure・SameSite=Strict（TLS の外では送られないことがある） */
export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 0 });
}
