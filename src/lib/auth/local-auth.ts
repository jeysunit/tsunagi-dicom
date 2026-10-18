import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendAudit, type AuditAction, type AuditEntryInput } from "@/lib/audit";
import { burnPasswordCheck, hashPassword, verifyPassword } from "@/lib/auth/password-hash";
import { checkPassword } from "@/lib/auth/password-policy";
import { defaultLoginThrottle, normalizeUsername, type LoginThrottle } from "@/lib/auth/rate-limit";
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
/** 大事な操作の前の本人の確かめ（再認証）が効く時間 */
export const REAUTH_MINUTES = 5;
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
  /** ログインの試みを遅らせ始める回数（1 分あたり。利用者名ごと・全体。src/lib/auth/rate-limit.ts） */
  rateLimitPerUserPerMinute: number;
  rateLimitGlobalPerMinute: number;
}

export interface AuthContext {
  db: Db;
  settings: AuthSettings;
  source: SourceAddress;
  now?: () => Date;
  /** 既定はプロセスで1つの数え手 */
  loginThrottle?: LoginThrottle;
  /** 待つ（試験で差し替える） */
  sleep?: (ms: number) => Promise<void>;
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
/** 大事な操作の前に、本人の確かめが要るときの印（AuthFailure の problems） */
export const REAUTH_REQUIRED = "reauth_required";

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

/**
 * ログインの試みを遅らせる（利用者名ごと・全体。src/lib/auth/rate-limit.ts）。利用者を引く前に数え、
 * 存在しない利用者名でも同じに遅らせる。断らない（ほかの人の失敗で、正しい利用者を締め出さない）。
 * 枠の中ではじめて遅らせ始めたときだけ記録に残す（利用者名は残さない）
 */
async function throttleLogin(ctx: AuthContext, username: string): Promise<void> {
  const throttle = ctx.loginThrottle ?? defaultLoginThrottle;
  const { delayMs, firstOver } = throttle.take(
    username,
    ctx.source.sourceAddress,
    { perKeyPerMinute: ctx.settings.rateLimitPerUserPerMinute, globalPerMinute: ctx.settings.rateLimitGlobalPerMinute },
    now(ctx).getTime(),
  );
  if (firstOver) {
    await record(ctx, { actorId: "unknown", actorRole: "none" }, { action: "login", outcome: "denied", detail: { reason: "throttled" } });
  }
  if (delayMs > 0) await (ctx.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(delayMs);
}

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

// ── ログインの一時停止（第7.0版 14 遵守事項⑥(6)） ──
// 確かめる前に「試みの枠」を1つ、原子的な更新で取る（失敗の数が決めた回数より少ないときだけ1つ増やす）。
// 同時に多くの要求を送っても、枠を取れた要求だけが確かめに進むので、決めた回数より多くは試せない。
// パスワードが合ったら（TOTP が残っていても）その枠を返し、ログイン・ロックの解除・再認証を終えたら数を0に戻す。

/** 試みの枠を取る。取れなければ（一時停止の中か、枠を使い切った）false */
async function claimAttempt(ctx: AuthContext, user: User): Promise<boolean> {
  const at = now(ctx);
  const res = await ctx.db.user.updateMany({
    where: {
      id: user.id,
      failedLoginCount: { lt: ctx.settings.loginLockThreshold },
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: at } }],
    },
    data: { failedLoginCount: { increment: 1 }, updatedAt: at },
  });
  return res.count === 1;
}

/** 合った試みの枠を返す */
async function releaseAttempt(ctx: AuthContext, user: User): Promise<void> {
  await ctx.db.user.updateMany({
    where: { id: user.id, failedLoginCount: { gt: 0 } },
    data: { failedLoginCount: { decrement: 1 } },
  });
}

async function resetAttempts(ctx: AuthContext, user: User): Promise<void> {
  await ctx.db.user.updateMany({
    where: { id: user.id, OR: [{ lockedUntil: null }, { lockedUntil: { lte: now(ctx) } }] },
    data: { failedLoginCount: 0 },
  });
}

/** 失敗を記録し、枠を使い切っていたら一時停止にする。一時停止になっていたら true */
async function registerFailure(ctx: AuthContext, user: User, reason: string, action: AuditAction = "login") {
  const at = now(ctx);
  await record(ctx, actorOf(user), { action, outcome: "denied", detail: { reason } });
  const lockedUntil = addMinutes(at, ctx.settings.loginLockMinutes);
  // 一時停止にするのは1つの要求だけ（同時の失敗が重なっても、一時停止の記録は1行）
  const res = await ctx.db.user.updateMany({
    where: { id: user.id, failedLoginCount: { gte: ctx.settings.loginLockThreshold } },
    data: { failedLoginCount: 0, lockedUntil, updatedAt: at },
  });
  if (res.count === 0) {
    const current = await ctx.db.user.findUnique({ where: { id: user.id } });
    return current !== null && current.lockedUntil !== null && current.lockedUntil > at;
  }
  // 一時停止の間は、ログインの途中のセッションも、ログインしたセッションも使わせない
  await ctx.db.session.deleteMany({ where: { userId: user.id } });
  await record(ctx, actorOf(user), {
    action: "login_lock",
    outcome: "success",
    detail: {
      failures: ctx.settings.loginLockThreshold,
      minutes: ctx.settings.loginLockMinutes,
      lockedUntil: lockedUntil.toISOString(),
    },
  });
  return true;
}

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

/**
 * ログインした利用者の、もう一度の本人の確かめ（パスワードと、登録していれば TOTP）。
 * 画面のロックの解除・再認証・パスワードの変更に使う。回数の上限と一時停止を、ログインと同じに数える
 */
async function verifyAgain(
  ctx: AuthContext,
  user: User,
  input: { password?: string; code?: string },
  action: AuditAction,
): Promise<void> {
  // 回数は利用者ごとの試みの枠で抑える（全体の枠に入れると、ほかの人のログインの要求でロック中の職員が戻れなくなる）
  if (!(await claimAttempt(ctx, user))) {
    await record(ctx, actorOf(user), { action, outcome: "denied", detail: { reason: "locked" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE, ["locked"]);
  }
  const passwordOk = await verifyPassword(input.password ?? "", user.passwordHash);
  let totpOk = true;
  if (passwordOk && user.totpSecretEnc) {
    const secret = totpSecretOf(ctx, user);
    totpOk = secret !== null && (await acceptTotp(ctx, user, secret, input.code ?? ""));
  }
  if (!passwordOk || !totpOk) {
    const locked = await registerFailure(ctx, user, passwordOk ? "bad_totp" : "bad_password", action);
    throw new AuthFailure(401, "パスワードか確認の番号が違う", locked ? ["locked"] : []);
  }
  await resetAttempts(ctx, user);
}

// ── ログイン ──

export interface LoginResult {
  token: string;
  stage: Stage;
  expiresAt: Date;
}

/** 段を進めた結果。active になったときは、新しい token のセッションに替えている（cookie を付け直す） */
export interface StageResult {
  stage: Stage;
  rotated?: { token: string; expiresAt: Date };
}

function nextStageAfterPassword(ctx: AuthContext, user: User): Stage {
  if (user.totpSecretEnc) return "totp";
  if (ctx.settings.mfaRequired) return "enroll";
  return user.mustChangePassword ? "change_password" : "active";
}

export async function login(ctx: AuthContext, rawUsername: string, password: string): Promise<LoginResult> {
  await throttleLogin(ctx, rawUsername);
  // 遅らせの数え方と同じ正規化（NFKC・小文字・空白の除去）で利用者を引く
  const username = normalizeUsername(rawUsername);
  const user = isValidUsername(username) ? await ctx.db.user.findUnique({ where: { username } }) : null;
  if (!user) {
    // 知らない利用者名でも、パスワードの確かめと同じほどの時間をかけ、同じ答えを返す。
    // 名前は、打ち間違えたパスワードであることがあるので、記録に入れない
    await burnPasswordCheck(password);
    await record(ctx, { actorId: "unknown", actorRole: "none" }, { action: "login", outcome: "denied", detail: { reason: "unknown_user" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  if (user.status !== "active") {
    await burnPasswordCheck(password);
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "disabled" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  if (!(await claimAttempt(ctx, user))) {
    await burnPasswordCheck(password);
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "locked" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  if (!(await verifyPassword(password, user.passwordHash))) {
    await registerFailure(ctx, user, "bad_password");
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  await releaseAttempt(ctx, user);

  // いまの規則に合わなくなったパスワード（MFA_REQUIRED を false にしたときの 8〜12 文字など）は、本人が変える。
  // 平文はここでしか見られないので、ここで確かめて印を付ける（TOTP の段を通る利用者にも効く）
  let current = user;
  if (
    !user.mustChangePassword &&
    checkPassword(password, { mfaRequired: ctx.settings.mfaRequired, username: user.username }).length > 0
  ) {
    current = await ctx.db.user.update({ where: { id: user.id }, data: { mustChangePassword: true, updatedAt: now(ctx) } });
  }

  const stage = nextStageAfterPassword(ctx, current);
  const result = await openSession(ctx, current, stage);
  if (stage === "active") await completeLogin(ctx, current, { mfa: false });
  return result;
}

async function openSession(ctx: AuthContext, user: User, stage: Stage): Promise<LoginResult> {
  const at = now(ctx);
  const token = randomBytes(32).toString("base64url");
  const expiresAt =
    stage === "active" ? addMinutes(at, SESSION_MAX_HOURS * 60) : addMinutes(at, PENDING_SESSION_MINUTES);
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
  await resetAttempts(ctx, user);
  await ctx.db.user.update({ where: { id: user.id }, data: { lastLoginAt: at, updatedAt: at } });
  await record(ctx, actorOf(user), { action: "login", outcome: "success", detail });
}

/**
 * 段を進める。active になるときは、途中のセッションを消して、新しい token・CSRF の token のセッションを開く
 * （途中の段の token を、ログインした後に使い続けない）。そしてログインを記録する
 */
async function advance(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  stage: Stage,
  detail: Record<string, unknown>,
): Promise<StageResult> {
  if (stage !== "active") {
    await ctx.db.session.update({
      where: { id: session.id },
      data: { stage, pendingTotpEnc: null, lastActivityAt: now(ctx) },
    });
    return { stage };
  }
  await ctx.db.session.deleteMany({ where: { id: session.id } });
  const opened = await openSession(ctx, user, "active");
  await completeLogin(ctx, user, detail);
  return { stage, rotated: { token: opened.token, expiresAt: opened.expiresAt } };
}

// ── TOTP ──

export async function submitTotp(ctx: AuthContext, session: SessionRow, user: User, code: string): Promise<StageResult> {
  if (session.stage !== "totp") throw new AuthFailure(409, "TOTP の入力の段ではない");
  const secret = totpSecretOf(ctx, user);
  if (!secret) {
    // SESSION_SECRET を替えたなどで読めない。管理者が TOTP をやり直す
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "totp_unreadable" } });
    throw new AuthFailure(409, "TOTP の秘密を読めない。管理者に TOTP のやり直しを頼む");
  }
  if (!(await claimAttempt(ctx, user))) {
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "locked" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE, ["locked"]);
  }
  if (!(await acceptTotp(ctx, user, secret, code))) {
    const locked = await registerFailure(ctx, user, "bad_totp");
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE, locked ? ["locked"] : []);
  }
  const fresh = await ctx.db.user.findUniqueOrThrow({ where: { id: user.id } });
  return advance(ctx, session, fresh, fresh.mustChangePassword ? "change_password" : "active", { mfa: true });
}

export interface Enrollment {
  secret: string;
  uri: string;
}

const isOptionalEnrollment = (ctx: AuthContext, session: SessionRow, user: User) =>
  session.stage === "active" && !ctx.settings.mfaRequired && !user.totpSecretEnc;

/** 登録を始める（新しい秘密を作り、セッションに暗号化して置く）。登録の段か、二要素が任意で未登録のログインしたセッション */
export async function startEnrollment(ctx: AuthContext, session: SessionRow, user: User): Promise<Enrollment> {
  if (session.stage !== "enroll" && !isOptionalEnrollment(ctx, session, user)) {
    throw new AuthFailure(409, "TOTP の登録の段ではない");
  }
  const secret = generateTotpSecret();
  await ctx.db.session.update({
    where: { id: session.id },
    data: { pendingTotpEnc: sealField(secret, ctx.settings.sessionSecret, session.id) },
  });
  return { secret, uri: otpauthUri(secret, user.username) };
}

/**
 * 登録を確かめる。二要素が任意のときの、ログインした後の登録では、いまのパスワードも確かめる
 * （離れた端末のセッションで、ほかの人の認証のアプリを結び付けられないように）
 */
export async function confirmEnrollment(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  code: string,
  currentPassword?: string,
): Promise<StageResult> {
  const optional = isOptionalEnrollment(ctx, session, user);
  if (session.stage !== "enroll" && !optional) throw new AuthFailure(409, "TOTP の登録の段ではない");
  const secret = session.pendingTotpEnc
    ? openField(session.pendingTotpEnc, ctx.settings.sessionSecret, session.id)
    : null;
  if (!secret) throw new AuthFailure(409, "登録の途中の秘密が無い。登録の画面を開き直す");
  if (optional) await verifyAgain(ctx, user, { password: currentPassword }, "mfa_enroll");
  const step = verifyTotp(secret, code, now(ctx).getTime());
  if (step === null) {
    await record(ctx, actorOf(user), { action: "mfa_enroll", outcome: "denied", detail: { reason: "bad_totp" } });
    throw new AuthFailure(400, "確認の番号が合わない。認証のアプリの番号を入れ直す");
  }
  const at = now(ctx);
  const updated = await ctx.db.user.update({
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
    return { stage: "active" };
  }
  return advance(ctx, session, updated, updated.mustChangePassword ? "change_password" : "active", {
    mfa: true,
    enrolled: true,
  });
}

// ── パスワードの変更 ──

export async function changePassword(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  input: { currentPassword?: string; code?: string; newPassword: string },
): Promise<StageResult> {
  if (session.stage !== "change_password" && session.stage !== "active") {
    throw new AuthFailure(409, "パスワードの変更の段ではない");
  }
  // ログインしたセッションでは、いまのパスワードと、登録していれば TOTP を確かめる（再認証）。
  // 変更の段は、いまログインで確かめたところなので求めない
  if (session.stage === "active") {
    await verifyAgain(ctx, user, { password: input.currentPassword, code: input.code }, "password_change");
  }
  const problems = checkPassword(input.newPassword, { mfaRequired: ctx.settings.mfaRequired, username: user.username });
  if (await verifyPassword(input.newPassword, user.passwordHash)) problems.push("いまのパスワードと違うものにする");
  if (problems.length > 0) throw new AuthFailure(400, "このパスワードは使えない", problems);

  const at = now(ctx);
  const updated = await ctx.db.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      passwordChangedAt: at,
      mustChangePassword: false,
      updatedAt: at,
    },
  });
  // ほかのセッションは閉じる
  await ctx.db.session.deleteMany({ where: { userId: user.id, id: { not: session.id } } });
  await record(ctx, actorOf(user), { action: "password_change", outcome: "success" });
  if (session.stage === "active") return { stage: "active" };
  return advance(ctx, session, updated, "active", { mfa: user.totpSecretEnc !== null, passwordChanged: true });
}

// ── 再認証（大事な操作の前の、もう一度の本人の確かめ） ──

/** パスワードと TOTP で本人を確かめ、REAUTH_MINUTES の間、大事な操作を許す */
export async function reauthenticate(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  input: { password: string; code?: string },
): Promise<void> {
  if (session.stage !== "active" || session.lockedAt) throw new AuthFailure(409, "ログインしていない");
  await verifyAgain(ctx, user, input, "reauth");
  await ctx.db.session.update({ where: { id: session.id }, data: { reauthAt: now(ctx) } });
  await record(ctx, actorOf(user), { action: "reauth", outcome: "success" });
}

/** 大事な操作（利用者の管理）の前に呼ぶ。REAUTH_MINUTES の中に再認証していなければ 403（problems に REAUTH_REQUIRED） */
export function assertRecentReauth(ctx: AuthContext, session: SessionRow): void {
  const at = now(ctx).getTime();
  if (session.reauthAt && at - session.reauthAt.getTime() < REAUTH_MINUTES * 60_000) return;
  throw new AuthFailure(403, "この操作の前に、パスワード（と確認の番号）をもう一度入れる", [REAUTH_REQUIRED]);
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
  const userLocked = user.lockedUntil !== null && user.lockedUntil > at;
  if (session.expiresAt <= at || user.status !== "active" || userLocked) {
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

/**
 * 利用者の操作があったことを覚える（サーバーの側の画面のロックの時間を数え直す）。
 * 画面が操作を知らせたとき（/api/auth/activity）だけ呼ぶ。画像の取得などの裏の要求では数え直さない。
 * 書き込みを減らすため、15 秒より短い間は覚え直さない
 */
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
  await verifyAgain(ctx, user, input, "screen_unlock");
  const at = now(ctx);
  await ctx.db.session.update({ where: { id: session.id }, data: { lockedAt: null, lastActivityAt: at } });
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

type Tx = Parameters<Parameters<Db["$transaction"]>[0]>[0];

/** 有効な管理者が1人もいなくなる変更は断る */
async function assertAdminRemains(db: Tx, target: User, change: UserChange) {
  const losesAdmin =
    target.role === "admin" &&
    target.status === "active" &&
    ((change.role !== undefined && change.role !== "admin") || change.status === "disabled");
  if (!losesAdmin) return;
  const others = await db.user.count({ where: { role: "admin", status: "active", id: { not: target.id } } });
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

  const at = now(ctx);
  let user = target;
  const roleChanged = change.role !== undefined && change.role !== target.role;
  const statusChanged = change.status !== undefined && change.status !== target.status;
  if (roleChanged || statusChanged) {
    // 「有効な管理者が残るか」の確かめと変更を1つの transaction にする
    // （2人の管理者が同時に互いを外しても、0 人にしない。SQLite は書き込みを一列に並べる）
    user = await ctx.db.$transaction(async (tx) => {
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: target.id } });
      await assertAdminRemains(tx, fresh, change);
      return tx.user.update({
        where: { id: target.id },
        data: {
          ...(roleChanged ? { role: change.role } : {}),
          ...(statusChanged ? { status: change.status } : {}),
          updatedAt: at,
        },
      });
    });
  } else {
    await assertAdminRemains(ctx.db, target, change);
  }
  if (roleChanged) {
    await record(ctx, by, { action: "role_change", detail: { target: target.username, from: target.role, to: change.role } });
  }
  if (statusChanged) {
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
