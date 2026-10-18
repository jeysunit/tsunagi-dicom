import "server-only";
import { cookies, headers } from "next/headers";
import { cache } from "react";
import { appendAudit, type AuditEntryInput } from "@/lib/audit";
import { decodeDevRole, DEV_ROLE_COOKIE } from "@/lib/auth/dev-role-cookie";
import { type AuthContext, resolveSession, type Stage } from "@/lib/auth/local-auth";
import { LOCK_COOKIE, parseLockCookie } from "@/lib/auth/lock-cookie";
import { can, DEFAULT_DEV_ROLE, isRole, type Permission, type Role } from "@/lib/auth/roles";
import { sourceFromHeaders } from "@/lib/auth/source-address";
import { getConfig, type AuthMode } from "@/lib/config";
import { getDb } from "@/lib/db";
import type { Session as SessionRow, User } from "@/generated/prisma/client";

/**
 * ログインのセッションの cookie（HttpOnly・Secure・SameSite=Strict・Path=/、Domain は付けない。src/lib/api/auth-route.ts）。
 * 名前の `__Host-` で、ブラウザは Secure・Path=/・Domain 無しの cookie だけを受ける（同じ親のドメインの
 * ほかの名前のサーバーや、TLS の無い頁が入れた同じ名前の cookie で、上書き・固定されないように）
 */
export const SESSION_COOKIE = "__Host-tsunagi_session";

export interface Session {
  actorId: string;
  role: Role;
  authMode: AuthMode;
  /** AUTH_MODE=local のときだけ */
  local?: { row: SessionRow; user: User };
}

export type AuthState =
  | { kind: "anonymous" }
  | { kind: "pending"; stage: Exclude<Stage, "active">; row: SessionRow; user: User }
  | { kind: "locked"; session: Session }
  | { kind: "active"; session: Session };

/** 認証の誤り。route handler では src/lib/api/respond.ts が状態の番号に写す */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 423,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

export async function authContext(): Promise<AuthContext> {
  const config = getConfig();
  return {
    db: await getDb(),
    settings: {
      mfaRequired: config.auth.mfaRequired,
      loginLockThreshold: config.auth.loginLockThreshold,
      loginLockMinutes: config.auth.loginLockMinutes,
      screenLockMinutes: config.auth.screenLockMinutes,
      sessionSecret: config.sessionSecret,
      rateLimitPerUserPerMinute: config.auth.rateLimitPerUserPerMinute,
      rateLimitGlobalPerMinute: config.auth.rateLimitGlobalPerMinute,
      passwordHashConcurrency: config.auth.passwordHashConcurrency,
      passwordHashQueue: config.auth.passwordHashQueue,
      pendingSessionMinutes: config.auth.pendingSessionMinutes,
      sessionMaxHours: config.auth.sessionMaxHours,
      reauthMinutes: config.auth.reauthMinutes,
    },
    source: sourceFromHeaders(await headers()),
  };
}

function toSession(user: User, row: SessionRow): Session {
  // 役割はデータベースの値を毎回読む（管理者が変えたら、次の要求から効く）
  const role: Role = isRole(user.role) ? user.role : "viewer";
  return { actorId: user.username, role, authMode: "local", local: { row, user } };
}

/** いまの要求の認証の状態。1つの要求の中では1回だけ引く */
export const getAuthState = cache(async (): Promise<AuthState> => {
  const config = getConfig();
  const jar = await cookies();
  if (config.auth.mode === "dev") {
    const role = decodeDevRole(jar.get(DEV_ROLE_COOKIE)?.value, config.sessionSecret) ?? DEFAULT_DEV_ROLE;
    return { kind: "active", session: { actorId: "dev", role, authMode: "dev" } };
  }
  if (config.auth.mode !== "local") throw new Error(`AUTH_MODE=${config.auth.mode} はまだ無い`);

  const ctx = await authContext();
  // 画面が置いたロックの印（src/lib/auth/lock-cookie.ts）があれば、この要求の時点でロックにする
  const resolved = await resolveSession(ctx, jar.get(SESSION_COOKIE)?.value, {
    lockRequested: parseLockCookie(jar.get(LOCK_COOKIE)?.value),
  });
  switch (resolved.kind) {
    case "anonymous":
      return { kind: "anonymous" };
    case "pending":
      return { kind: "pending", stage: resolved.session.stage as Exclude<Stage, "active">, row: resolved.session, user: resolved.user };
    case "locked":
      return { kind: "locked", session: toSession(resolved.user, resolved.session) };
    case "active":
      // 操作の時刻は、画面が操作を知らせたとき（/api/auth/activity）だけ数え直す（画像の取得などの裏の要求では数えない）
      return { kind: "active", session: toSession(resolved.user, resolved.session) };
  }
});

/**
 * ログインしていて、画面のロックが無く、操作の権限がある利用者を返す。そうでなければ AuthError を投げる
 * （401：ログインしていない、423：画面のロック中、403：役割に権限が無い）
 */
export async function requireSession(permission?: Permission): Promise<Session> {
  const state = await getAuthState();
  if (state.kind === "anonymous" || state.kind === "pending") throw new AuthError(401, "ログインしていない");
  if (state.kind === "locked") throw new AuthError(423, "画面をロックしている。パスワードで解く");
  if (permission && !can(state.session.role, permission)) {
    throw new AuthError(403, "この役割ではできない操作");
  }
  return state.session;
}

/** 互換のため：いまの利用者（権限は見ない） */
export async function getSession(): Promise<Session> {
  return requireSession();
}

export type AuditFields = Omit<
  AuditEntryInput,
  "actorId" | "actorRole" | "authMode" | "sourceAddress" | "sourceAddressUnverified"
>;

/** いまの利用者で監査の記録に1行足す。接続元の分け方は src/lib/auth/source-address.ts */
export async function audit(session: Session, fields: AuditFields) {
  const db = await getDb();
  return appendAudit(db, {
    ...fields,
    actorId: session.actorId,
    actorRole: session.role,
    authMode: session.authMode,
    ...sourceFromHeaders(await headers()),
  });
}
