import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendAudit, type AuditEntryInput } from "@/lib/audit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "@/lib/auth/password-hash";
import { checkPassword } from "@/lib/auth/password-policy";
import { isRole, type Role } from "@/lib/auth/roles";
import { openField, sealField } from "@/lib/auth/sealed-field";
import type { SourceAddress } from "@/lib/auth/source-address";
import { generateTotpSecret, otpauthUri, verifyTotp } from "@/lib/auth/totp";
import { isValidUsername, USERNAME_HINT } from "@/lib/auth/username";
import type { Db } from "@/lib/db";
import type { Session as SessionRow, User } from "@/generated/prisma/client";

// アプリの利用者のログイン（AUTH_MODE=local。docs/spec.md の 3.6）。
// 画面と API（src/app/api/auth/...）から呼ぶ中身。データベース・設定・時計を外から渡し、試験で差し替える。
// 監査の記録には、パスワード・TOTP の値・セッションの token を入れない。

export const AUTH_MODE_LOCAL = "local";
/** ログインの途中（TOTP の入力・登録・パスワードの変更の待ち）のセッションの長さ */
export const PENDING_SESSION_MINUTES = 10;
/** ログインしたセッションの長さ（操作があっても、これを過ぎたらログインし直す） */
export const SESSION_MAX_HOURS = 12;
/**
 * サーバーの側の画面のロックの猶予。画面の側（ブラウザ）が SCREEN_LOCK_MINUTES でロックするのが主で、
 * サーバーの側は、閉じた・離れたタブのための保険として、さらにこの秒数を待ってからロックする
 */
export const SERVER_LOCK_GRACE_SECONDS = 60;

export type Stage = "totp" | "enroll" | "change_password" | "active";

export interface AuthSettings {
  mfaRequired: boolean;
  loginLockThreshold: number;
  loginLockMinutes: number;
  screenLockMinutes: number;
  sessionSecret: string;
}

export interface AuthContext {
  db: Db;
  settings: AuthSettings;
  source: SourceAddress;
  now?: () => Date;
}

export class AuthFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: string[] = [],
  ) {
    super(message);
    this.name = "AuthFailure";
  }
}

/** ログインの失敗の文言は1つにする（利用者名の有無・一時停止の有無を、答えの違いで知られないように） */
export const LOGIN_FAILED_MESSAGE =
  "利用者名かパスワード（か確認の番号）が違う。または、続けて失敗したため、しばらくログインを止めている";

const now = (ctx: AuthContext) => (ctx.now ? ctx.now() : new Date());
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

async function record(
  ctx: AuthContext,
  actor: { actorId: string; actorRole: string },
  fields: Omit<AuditEntryInput, "actorId" | "actorRole" | "authMode">,
) {
  await appendAudit(ctx.db, {
    ...fields,
    ...actor,
    authMode: AUTH_MODE_LOCAL,
    sourceAddress: ctx.source.sourceAddress,
    sourceAddressUnverified: ctx.source.sourceAddressUnverified,
    occurredAt: now(ctx),
  });
}

const actorOf = (user: Pick<User, "username" | "role">) => ({ actorId: user.username, actorRole: user.role });

// ── 利用者を作る ──

export interface NewUser {
  username: string;
  displayName: string;
  role: Role;
  password: string;
  mustChangePassword: boolean;
}

export async function createUser(
  ctx: AuthContext,
  input: NewUser,
  by: { actorId: string; actorRole: string },
): Promise<User> {
  const problems: string[] = [];
  if (!isValidUsername(input.username)) problems.push(`利用者名：${USERNAME_HINT}`);
  const displayName = input.displayName.trim();
  if (displayName === "" || displayName.length > 100) problems.push("表示の名前：1〜100 文字");
  if (!isRole(input.role)) problems.push("役割：admin・doctor・technologist・viewer のどれか");
  for (const p of checkPassword(input.password, { mfaRequired: ctx.settings.mfaRequired, username: input.username })) {
    problems.push(`パスワード：${p}`);
  }
  if (problems.length > 0) throw new AuthFailure(400, "利用者を作れない", problems);
  if (await ctx.db.user.findUnique({ where: { username: input.username } })) {
    throw new AuthFailure(409, "同じ利用者名がもうある");
  }

  const at = now(ctx);
  const user = await ctx.db.user.create({
    data: {
      id: randomUUID(),
      username: input.username,
      displayName,
      role: input.role,
      passwordHash: await hashPassword(input.password),
      passwordChangedAt: at,
      mustChangePassword: input.mustChangePassword,
      createdAt: at,
      updatedAt: at,
    },
  });
  await record(ctx, by, {
    action: "user_create",
    detail: { target: user.username, role: user.role, mustChangePassword: user.mustChangePassword },
  });
  return user;
}

// ── ログイン ──

export interface LoginResult {
  token: string;
  stage: Stage;
  expiresAt: Date;
}

function nextStageAfterPassword(ctx: AuthContext, user: User, password: string | null): Stage {
  if (user.totpSecretEnc) return "totp";
  if (ctx.settings.mfaRequired) return "enroll";
  return passwordChangeNeeded(ctx, user, password) ? "change_password" : "active";
}

/** 管理者が決めたパスワード、いまの規則に合わなくなったパスワード（MFA_REQUIRED を替えたときなど）は、本人が変える */
function passwordChangeNeeded(ctx: AuthContext, user: User, password: string | null): boolean {
  if (user.mustChangePassword) return true;
  if (password === null) return false;
  return checkPassword(password, { mfaRequired: ctx.settings.mfaRequired, username: user.username }).length > 0;
}

/** 失敗を数え、決めた回数に届いたら一時停止にする。一時停止にしたら true */
async function registerFailure(
  ctx: AuthContext,
  user: User,
  reason: string,
  action: "login" | "screen_unlock" = "login",
) {
  const at = now(ctx);
  const updated = await ctx.db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: { increment: 1 }, updatedAt: at },
  });
  await record(ctx, actorOf(user), { action, outcome: "denied", detail: { reason } });
  if (updated.failedLoginCount < ctx.settings.loginLockThreshold) return false;

  const lockedUntil = addMinutes(at, ctx.settings.loginLockMinutes);
  await ctx.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil, updatedAt: at } });
  // 一時停止の間は、ログインの途中のセッションも、ログインしたセッションも使わせない
  await ctx.db.session.deleteMany({ where: { userId: user.id } });
  await record(ctx, actorOf(user), {
    action: "login_lock",
    outcome: "success",
    detail: { failures: ctx.settings.loginLockThreshold, minutes: ctx.settings.loginLockMinutes, lockedUntil: lockedUntil.toISOString() },
  });
  return true;
}

const isLocked = (ctx: AuthContext, user: User) => user.lockedUntil !== null && user.lockedUntil > now(ctx);

export async function login(ctx: AuthContext, username: string, password: string): Promise<LoginResult> {
  const user = isValidUsername(username) ? await ctx.db.user.findUnique({ where: { username } }) : null;
  if (!user) {
    await burnPasswordCheck(password);
    // 知らない利用者名は、打ち間違えたパスワードであることがあるので、記録に入れない
    await record(ctx, { actorId: "unknown", actorRole: "none" }, { action: "login", outcome: "denied", detail: { reason: "unknown_user" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  if (isLocked(ctx, user)) {
    await burnPasswordCheck(password);
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "locked" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (user.status !== "active") {
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "disabled" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  if (!ok) {
    await registerFailure(ctx, user, "bad_password");
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }

  const stage = nextStageAfterPassword(ctx, user, password);
  const result = await openSession(ctx, user, stage);
  if (stage === "active") await completeLogin(ctx, user, { mfa: false });
  return result;
}

async function openSession(ctx: AuthContext, user: User, stage: Stage): Promise<LoginResult> {
  const at = now(ctx);
  const token = randomBytes(32).toString("base64url");
  const expiresAt = stage === "active" ? addMinutes(at, SESSION_MAX_HOURS * 60) : addMinutes(at, PENDING_SESSION_MINUTES);
  await ctx.db.session.create({
    data: {
      id: hashToken(token),
      userId: user.id,
      stage,
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: at,
      expiresAt,
      lastActivityAt: at,
    },
  });
  return { token, stage, expiresAt };
}

async function completeLogin(ctx: AuthContext, user: User, detail: Record<string, unknown>) {
  const at = now(ctx);
  await ctx.db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: at, updatedAt: at },
  });
  await record(ctx, actorOf(user), { action: "login", outcome: "success", detail });
}

/** 段を進める。active になったら、セッションの長さを延ばし、ログインを記録する */
async function advance(ctx: AuthContext, session: SessionRow, user: User, stage: Stage, detail: Record<string, unknown>) {
  const at = now(ctx);
  await ctx.db.session.update({
    where: { id: session.id },
    data: {
      stage,
      pendingTotpEnc: null,
      lastActivityAt: at,
      ...(stage === "active" ? { expiresAt: addMinutes(at, SESSION_MAX_HOURS * 60) } : {}),
    },
  });
  if (stage === "active") await completeLogin(ctx, user, detail);
  return stage;
}

// ── TOTP ──

function totpSecretOf(ctx: AuthContext, user: User): string | null {
  return user.totpSecretEnc ? openField(user.totpSecretEnc, ctx.settings.sessionSecret, user.id) : null;
}

/** TOTP を確かめ、使った段を覚える（同じ段・前の段の使い回しを断る）。合えば true */
async function acceptTotp(ctx: AuthContext, user: User, secret: string, code: string): Promise<boolean> {
  const step = verifyTotp(secret, code, now(ctx).getTime(), user.totpLastStep);
  if (step === null) return false;
  const claimed = await ctx.db.user.updateMany({
    where: { id: user.id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
    data: { totpLastStep: step },
  });
  return claimed.count === 1;
}

export async function submitTotp(ctx: AuthContext, session: SessionRow, user: User, code: string): Promise<Stage> {
  if (session.stage !== "totp") throw new AuthFailure(409, "TOTP の入力の段ではない");
  if (isLocked(ctx, user)) throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  const secret = totpSecretOf(ctx, user);
  if (!secret) {
    // SESSION_SECRET を替えたなどで読めない。管理者が TOTP をやり直す
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "totp_unreadable" } });
    throw new AuthFailure(409, "TOTP の秘密を読めない。管理者に TOTP のやり直しを頼む");
  }
  if (!(await acceptTotp(ctx, user, secret, code))) {
    const locked = await registerFailure(ctx, user, "bad_totp");
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE, locked ? ["locked"] : []);
  }
  const stage = passwordChangeNeeded(ctx, user, null) ? "change_password" : "active";
  return advance(ctx, session, user, stage, { mfa: true });
}

export interface Enrollment {
  secret: string;
  uri: string;
}

/** 登録を始める（新しい秘密を作り、セッションに暗号化して置く）。登録の段か、二要素が任意で未登録のログインしたセッション */
export async function startEnrollment(ctx: AuthContext, session: SessionRow, user: User): Promise<Enrollment> {
  const optional = session.stage === "active" && !ctx.settings.mfaRequired && !user.totpSecretEnc;
  if (session.stage !== "enroll" && !optional) throw new AuthFailure(409, "TOTP の登録の段ではない");
  const secret = generateTotpSecret();
  await ctx.db.session.update({
    where: { id: session.id },
    data: { pendingTotpEnc: sealField(secret, ctx.settings.sessionSecret, session.id) },
  });
  return { secret, uri: otpauthUri(secret, user.username) };
}

export async function confirmEnrollment(ctx: AuthContext, session: SessionRow, user: User, code: string): Promise<Stage> {
  const optional = session.stage === "active" && !ctx.settings.mfaRequired && !user.totpSecretEnc;
  if (session.stage !== "enroll" && !optional) throw new AuthFailure(409, "TOTP の登録の段ではない");
  const secret = session.pendingTotpEnc ? openField(session.pendingTotpEnc, ctx.settings.sessionSecret, session.id) : null;
  if (!secret) throw new AuthFailure(409, "登録の途中の秘密が無い。登録の画面を開き直す");
  const step = verifyTotp(secret, code, now(ctx).getTime());
  if (step === null) {
    await record(ctx, actorOf(user), { action: "mfa_enroll", outcome: "denied", detail: { reason: "bad_totp" } });
    throw new AuthFailure(400, "確認の番号が合わない。認証のアプリの番号を入れ直す");
  }
  const at = now(ctx);
  await ctx.db.user.update({
    where: { id: user.id },
    data: {
      totpSecretEnc: sealField(secret, ctx.settings.sessionSecret, user.id),
      totpEnabledAt: at,
      totpLastStep: step,
      updatedAt: at,
    },
  });
  await record(ctx, actorOf(user), { action: "mfa_enroll", outcome: "success" });
  if (optional) {
    await ctx.db.session.update({ where: { id: session.id }, data: { pendingTotpEnc: null } });
    return "active";
  }
  const stage = passwordChangeNeeded(ctx, user, null) ? "change_password" : "active";
  return advance(ctx, session, user, stage, { mfa: true, enrolled: true });
}

// ── パスワードの変更 ──

export async function changePassword(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  input: { currentPassword?: string; newPassword: string },
): Promise<Stage> {
  if (session.stage !== "change_password" && session.stage !== "active") {
    throw new AuthFailure(409, "パスワードの変更の段ではない");
  }
  // ログインしたセッションでは、いまのパスワードを確かめる（変更の段は、いまログインで確かめたところ）
  if (session.stage === "active") {
    if (!input.currentPassword || !(await verifyPassword(input.currentPassword, user.passwordHash))) {
      await record(ctx, actorOf(user), { action: "password_change", outcome: "denied", detail: { reason: "bad_password" } });
      throw new AuthFailure(400, "いまのパスワードが違う");
    }
  }
  const problems = checkPassword(input.newPassword, { mfaRequired: ctx.settings.mfaRequired, username: user.username });
  if (await verifyPassword(input.newPassword, user.passwordHash)) problems.push("いまのパスワードと違うものにする");
  if (problems.length > 0) throw new AuthFailure(400, "このパスワードは使えない", problems);

  const at = now(ctx);
  await ctx.db.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(input.newPassword), passwordChangedAt: at, mustChangePassword: false, updatedAt: at },
  });
  // ほかのセッションは閉じる
  await ctx.db.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } });
  await record(ctx, actorOf(user), { action: "password_change", outcome: "success" });
  if (session.stage === "active") return "active";
  return advance(ctx, session, user, "active", { mfa: user.totpSecretEnc !== null, passwordChanged: true });
}

// ── セッション ──

export type ResolvedSession =
  | { kind: "anonymous" }
  | { kind: "pending" | "locked" | "active"; session: SessionRow; user: User };

/** cookie の token からセッションを引く。長く操作が無ければ、ここでロックにする（サーバーの側の保険） */
export async function resolveSession(ctx: AuthContext, token: string | undefined): Promise<ResolvedSession> {
  if (!token || token.length > 128) return { kind: "anonymous" };
  const row = await ctx.db.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
  if (!row) return { kind: "anonymous" };
  const { user, ...session } = row;
  const at = now(ctx);
  if (session.expiresAt <= at || user.status !== "active" || isLocked(ctx, user)) {
    await ctx.db.session.deleteMany({ where: { id: session.id } });
    return { kind: "anonymous" };
  }
  if (session.stage !== "active") return { kind: "pending", session, user };
  if (session.lockedAt) return { kind: "locked", session, user };

  const minutes = ctx.settings.screenLockMinutes;
  const idleMs = at.getTime() - session.lastActivityAt.getTime();
  if (minutes > 0 && idleMs >= minutes * 60_000 + SERVER_LOCK_GRACE_SECONDS * 1000) {
    const locked = await lockScreen(ctx, session, user, "idle");
    return { kind: "locked", session: locked, user };
  }
  return { kind: "active", session, user };
}

/** 操作があったことを覚える（画面のロックの時間を数え直す）。書き込みを減らすため、15 秒より短い間は覚え直さない */
export async function touchSession(ctx: AuthContext, session: SessionRow): Promise<void> {
  const at = now(ctx);
  if (at.getTime() - session.lastActivityAt.getTime() < 15_000) return;
  await ctx.db.session.updateMany({ where: { id: session.id, lockedAt: null }, data: { lastActivityAt: at } });
}

export async function logout(ctx: AuthContext, session: SessionRow, user: User): Promise<void> {
  await ctx.db.session.deleteMany({ where: { id: session.id } });
  await record(ctx, actorOf(user), { action: "logout", outcome: "success" });
}

// ── 画面のロック（第7.0版 12 遵守事項⑥） ──

export async function lockScreen(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  reason: "idle" | "client_idle" | "manual",
): Promise<SessionRow> {
  const at = now(ctx);
  const res = await ctx.db.session.updateMany({ where: { id: session.id, lockedAt: null }, data: { lockedAt: at } });
  if (res.count === 1) await record(ctx, actorOf(user), { action: "screen_lock", outcome: "success", detail: { reason } });
  return { ...session, lockedAt: session.lockedAt ?? at };
}

/** ロックを解く。パスワードと、登録していれば TOTP。失敗はログインの失敗と同じに数える */
export async function unlockScreen(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  input: { password: string; code?: string },
): Promise<void> {
  if (session.stage !== "active") throw new AuthFailure(409, "ログインしていない");
  if (isLocked(ctx, user)) throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  const passwordOk = await verifyPassword(input.password, user.passwordHash);
  let totpOk = true;
  if (passwordOk && user.totpSecretEnc) {
    const secret = totpSecretOf(ctx, user);
    totpOk = secret !== null && (await acceptTotp(ctx, user, secret, input.code ?? ""));
  }
  if (!passwordOk || !totpOk) {
    const locked = await registerFailure(ctx, user, passwordOk ? "bad_totp" : "bad_password", "screen_unlock");
    throw new AuthFailure(401, "パスワードか確認の番号が違う", locked ? ["locked"] : []);
  }
  const at = now(ctx);
  await ctx.db.session.update({ where: { id: session.id }, data: { lockedAt: null, lastActivityAt: at } });
  await ctx.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, updatedAt: at } });
  await record(ctx, actorOf(user), { action: "screen_unlock", outcome: "success" });
}

// ── 管理者の操作（利用者の棚卸し・役割・止める・TOTP のやり直し・一時停止の解除） ──

export interface UserListItem {
  id: string;
  username: string;
  displayName: string;
  role: string;
  status: string;
  lastLoginAt: Date | null;
  /** 最後のログインから何日か（棚卸しの目安） */
  lastLoginDaysAgo: number | null;
  createdAt: Date;
  totpEnabled: boolean;
  lockedUntil: Date | null;
}

export async function listUsers(ctx: AuthContext): Promise<UserListItem[]> {
  const users = await ctx.db.user.findMany({ orderBy: { username: "asc" } });
  const at = now(ctx);
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    lastLoginAt: u.lastLoginAt,
    lastLoginDaysAgo: u.lastLoginAt ? Math.floor((at.getTime() - u.lastLoginAt.getTime()) / 86_400_000) : null,
    createdAt: u.createdAt,
    totpEnabled: u.totpSecretEnc !== null,
    lockedUntil: u.lockedUntil && u.lockedUntil > at ? u.lockedUntil : null,
  }));
}

export interface UserChange {
  role?: Role;
  status?: "active" | "disabled";
  resetTotp?: boolean;
  clearLoginLock?: boolean;
}

/** 有効な管理者が1人もいなくなる変更は断る */
async function assertAdminRemains(ctx: AuthContext, target: User, change: UserChange) {
  const losesAdmin =
    target.role === "admin" &&
    target.status === "active" &&
    ((change.role !== undefined && change.role !== "admin") || change.status === "disabled");
  if (!losesAdmin) return;
  const others = await ctx.db.user.count({ where: { role: "admin", status: "active", id: { not: target.id } } });
  if (others === 0) throw new AuthFailure(409, "有効な管理者が1人もいなくなるので、変えられない");
}

export async function updateUser(
  ctx: AuthContext,
  targetId: string,
  change: UserChange,
  by: { actorId: string; actorRole: string },
): Promise<User> {
  const target = await ctx.db.user.findUnique({ where: { id: targetId } });
  if (!target) throw new AuthFailure(404, "利用者が無い");
  if (change.role !== undefined && !isRole(change.role)) throw new AuthFailure(400, "役割が誤り");
  if (change.status !== undefined && change.status !== "active" && change.status !== "disabled") {
    throw new AuthFailure(400, "状態は active か disabled");
  }
  await assertAdminRemains(ctx, target, change);

  const at = now(ctx);
  let user = target;
  if (change.role !== undefined && change.role !== target.role) {
    user = await ctx.db.user.update({ where: { id: target.id }, data: { role: change.role, updatedAt: at } });
    await record(ctx, by, {
      action: "role_change",
      detail: { target: target.username, from: target.role, to: change.role },
    });
  }
  if (change.status !== undefined && change.status !== target.status) {
    user = await ctx.db.user.update({ where: { id: target.id }, data: { status: change.status, updatedAt: at } });
    if (change.status === "disabled") await ctx.db.session.deleteMany({ where: { userId: target.id } });
    await record(ctx, by, {
      action: "user_status_change",
      detail: { target: target.username, from: target.status, to: change.status },
    });
  }
  if (change.resetTotp) {
    user = await ctx.db.user.update({
      where: { id: target.id },
      data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, updatedAt: at },
    });
    await ctx.db.session.deleteMany({ where: { userId: target.id } });
    await record(ctx, by, { action: "mfa_reset", detail: { target: target.username } });
  }
  if (change.clearLoginLock) {
    user = await ctx.db.user.update({
      where: { id: target.id },
      data: { failedLoginCount: 0, lockedUntil: null, updatedAt: at },
    });
    await record(ctx, by, { action: "login_unlock", detail: { target: target.username } });
  }
  return user;
}

/** CSRF の token を比べる（長さの違いも時間で漏らさない） */
export function csrfMatches(expected: string, given: string | null): boolean {
  if (!given) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(given).digest();
  return timingSafeEqual(a, b);
}
