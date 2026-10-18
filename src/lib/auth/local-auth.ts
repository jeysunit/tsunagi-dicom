import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendAudit, type AuditAction, type AuditEntryInput } from "@/lib/audit";
import { defaultFailureDigest, type DigestActor, type FailureDigest } from "@/lib/auth/failure-digest";
import {
  HASH_BUSY_RETRY_AFTER_SECONDS,
  HashBusyError,
  sharedHashLimiter,
  type HashLane,
  type HashLimiter,
} from "@/lib/auth/hash-limiter";
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from "@/lib/auth/password-hash";
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
// 下の3つは既定の値。運用に合わせて設定で変える（LOGIN_PENDING_MINUTES・SESSION_MAX_HOURS・REAUTH_MINUTES。
// src/lib/config.ts、docs/spec.md の 2.1。2026-10-18 に承認者が決めた）
/** ログインの途中（TOTP の入力・登録・パスワードの変更の待ち）のセッションの長さの既定 */
export const PENDING_SESSION_MINUTES = 10;
/** ログインしたセッションの長さの既定（操作があっても、これを過ぎたらログインし直す） */
export const SESSION_MAX_HOURS = 12;
/** 大事な操作の前の本人の確かめ（再認証）が効く時間の既定 */
export const REAUTH_MINUTES = 5;
/**
 * サーバーの側の画面のロックの猶予。ロックはサーバーの側を正にするので、画面が最後に操作を知らせてから
 * SCREEN_LOCK_MINUTES を過ぎたら、猶予を置かずに、その要求の時点でロックする（画面の側のロックの知らせが
 * 届かなくても、読み直した頁・別のタブは BFF が中身なしで描く）。画面は操作があれば 15 秒に1回まで知らせるので、
 * 画面の側より最大 15 秒早くロックしうる（閉じる側）
 */
export const SERVER_LOCK_GRACE_SECONDS = 0;

export type Stage = "totp" | "enroll" | "change_password" | "active";

export interface AuthSettings {
  mfaRequired: boolean;
  loginLockThreshold: number;
  loginLockMinutes: number;
  screenLockMinutes: number;
  /** 画面のロックを解くときに TOTP も求めるか（既定 false：パスワードだけ。docs/spec.md の 3.6） */
  screenUnlockRequireTotp: boolean;
  sessionSecret: string;
  /** ログインの試みを遅らせ始める回数（1 分あたり。利用者名ごと・全体。src/lib/auth/rate-limit.ts） */
  rateLimitPerUserPerMinute: number;
  rateLimitGlobalPerMinute: number;
  /** パスワードのハッシュ（argon2id）をログインの枠で同時に回す数と、待たせる数（src/lib/auth/hash-limiter.ts） */
  passwordHashConcurrency: number;
  passwordHashQueue: number;
  /** ログインの途中のセッションの長さ（分）・ログインしたセッションの長さ（時間）・再認証が効く時間（分） */
  pendingSessionMinutes: number;
  sessionMaxHours: number;
  reauthMinutes: number;
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
  /** 既定はプロセスで1つ（設定の passwordHashConcurrency・passwordHashQueue） */
  hashLimiter?: HashLimiter;
  /** 既定はプロセスで1つ（src/lib/auth/failure-digest.ts） */
  failureDigest?: FailureDigest;
  /** ログインの失敗の答えを返すまでの下限（既定 LOGIN_FAILURE_FLOOR_MS。試験で差し替える） */
  loginFailureFloorMs?: number;
}

/**
 * ログインの失敗の答えを返すまでの下限（遅らせの後、利用者を引き始めてから。実の時計で数える）。
 * パスワードの確かめ（argon2id。手元の測りで 30 ミリ秒ほど）より十分に長くし、利用者名の有無による
 * データベースの仕事の量の差（手元の測りで中央値 0.7 ミリ秒。docs/spec.md の 3.6）を答えの時間に出さない
 */
export const LOGIN_FAILURE_FLOOR_MS = 250;

/** 実の時計で、決めた時刻まで待つ */
async function padUntil(deadline: number): Promise<void> {
  const rest = deadline - performance.now();
  if (rest > 0) await new Promise<void>((r) => setTimeout(r, rest));
}

export class AuthFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly problems: string[] = [],
    /** 503 のとき、もう一度試すまでの秒数（Retry-After） */
    readonly retryAfterSeconds?: number,
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
/** パスワードの確かめが混んで断ったときの文言（503） */
export const HASH_BUSY_MESSAGE = "いまログインの要求が混んでいる。少し待ってから、もう一度試す";
/** 失敗したので、ログインの途中のセッションを捨てたときの印（AuthFailure の problems。画面はログインへ戻る） */
export const SESSION_CLOSED = "session_closed";
/** ログインの途中のセッションが、もう使えないとき（ほかの画面で先に進んだ・閉じた） */
export const SESSION_GONE_MESSAGE = "このログインの途中のセッションは、もう使えない。ログインし直す";

const now = (ctx: AuthContext) => (ctx.now ? ctx.now() : new Date());

const limiterOf = (ctx: AuthContext) =>
  ctx.hashLimiter ??
  sharedHashLimiter({ concurrency: ctx.settings.passwordHashConcurrency, queueLimit: ctx.settings.passwordHashQueue });
const digestOf = (ctx: AuthContext) => ctx.failureDigest ?? defaultFailureDigest;
const busyFailure = () => new AuthFailure(503, HASH_BUSY_MESSAGE, ["busy"], HASH_BUSY_RETRY_AFTER_SECONDS);

/** パスワードのハッシュを、枠を取って回す。枠も待ちの席も無ければ 503（AuthFailure） */
async function hashing<T>(ctx: AuthContext, lane: HashLane, fn: () => Promise<T>): Promise<T> {
  try {
    return await limiterOf(ctx).run(lane, fn);
  } catch (error) {
    if (error instanceof HashBusyError) throw busyFailure();
    throw error;
  }
}
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

const UNKNOWN_ACTOR: DigestActor = { actorId: "unknown", actorRole: "none" };

/**
 * まとめておいたログインの失敗（src/lib/auth/failure-digest.ts）を、1 分の枠が替わっていれば記録に書く。
 * force なら枠の途中でも書く。ログインの要求のはじめと、一定の間隔の片付け（src/lib/startup.ts）から呼ぶ
 */
export async function flushFailureDigest(ctx: AuthContext, force = false): Promise<number> {
  const digest = digestOf(ctx);
  const entries = digest.take(now(ctx).getTime(), force);
  for (const [i, e] of entries.entries()) {
    try {
      await appendAudit(ctx.db, {
        actorId: e.actorId,
        actorRole: e.actorRole,
        authMode: AUTH_MODE_LOCAL,
        action: "login",
        outcome: "denied",
        // まとめた行は、いろいろな接続元の試みを含みうるので、接続元を入れない
        sourceAddress: null,
        sourceAddressUnverified: null,
        occurredAt: now(ctx),
        detail: { reason: e.reason, aggregated: e.count, firstAt: e.firstAt.toISOString(), lastAt: e.lastAt.toISOString() },
      });
    } catch (error) {
      // 書けなかった分（この行と、まだ書いていない行）を戻して、次に書き直す
      digest.restore(entries.slice(i));
      throw error;
    }
  }
  return entries.length;
}

/**
 * ログインの失敗を記録する。遅らせの上限を超えた試み（throttled）の失敗は、1行ずつではなく、
 * 1 分の枠ごとに「利用者×理由」でまとめる（監査の行が、攻撃の要求の数だけ膨らまないように）
 */
async function recordLoginDenied(ctx: AuthContext, actor: DigestActor, reason: string, throttled: boolean) {
  if (throttled) {
    digestOf(ctx).add(actor, reason, now(ctx));
    return;
  }
  await record(ctx, actor, { action: "login", outcome: "denied", detail: { reason } });
}

/**
 * ログインの試みを遅らせる（利用者名ごと・全体。src/lib/auth/rate-limit.ts）。利用者を引く前に数え、
 * 存在しない利用者名でも同じに遅らせる。断らない（ほかの人の失敗で、正しい利用者を締め出さない）。
 * 枠の中ではじめて遅らせ始めたときだけ記録に残す（利用者名は残さない）。
 * ただし、パスワードの確かめの枠と待ちの席が埋まっていれば、待たせずにすぐ 503 で断る（src/lib/auth/hash-limiter.ts）。
 * 遅らせたら throttled（その試みの失敗は、まとめて記録する）
 */
async function throttleLogin(ctx: AuthContext, username: string): Promise<{ throttled: boolean }> {
  // 前の枠のまとめた行を書く。書けなくても（戻して次に書き直すので）このログインは止めない
  await flushFailureDigest(ctx).catch((error: unknown) => console.error("tsunagi-dicom: まとめた失敗の記録を書けなかった", error));
  const throttle = ctx.loginThrottle ?? defaultLoginThrottle;
  const { delayMs, firstOver, globalOver, firstGlobalOver } = throttle.take(
    username,
    ctx.source.sourceAddress,
    { perKeyPerMinute: ctx.settings.rateLimitPerUserPerMinute, globalPerMinute: ctx.settings.rateLimitGlobalPerMinute },
    now(ctx).getTime(),
  );
  // 遅らせ始めた印は1行ずつ残す。ただし全体の数が上限を超えた後は（名前を次々に替える試みで、
  // 桶の数だけ行が増えないように）、全体で超えた1行のほかは、まとめて残す
  if (firstGlobalOver || (firstOver && !globalOver)) {
    await record(ctx, UNKNOWN_ACTOR, { action: "login", outcome: "denied", detail: { reason: "throttled" } });
  } else if (firstOver) {
    digestOf(ctx).add(UNKNOWN_ACTOR, "throttled", now(ctx));
  }
  if (limiterOf(ctx).wouldReject("login")) {
    digestOf(ctx).add(UNKNOWN_ACTOR, "busy", now(ctx));
    throw busyFailure();
  }
  if (delayMs > 0) await (ctx.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(delayMs);
  return { throttled: delayMs > 0 };
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
      passwordHash: await hashing(ctx, "priority", () => hashPassword(input.password)),
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

/**
 * 失敗を記録し、枠を使い切っていたら一時停止にする。一時停止になっていたら true。
 * throttled（遅らせの上限を超えたログインの試み）の失敗は、まとめて記録する（一時停止の記録はいつも1行）
 */
async function registerFailure(
  ctx: AuthContext,
  user: User,
  reason: string,
  action: AuditAction = "login",
  throttled = false,
) {
  const at = now(ctx);
  if (action === "login") await recordLoginDenied(ctx, actorOf(user), reason, throttled);
  else await record(ctx, actorOf(user), { action, outcome: "denied", detail: { reason } });
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
  // 一時停止にしたら、ログインの途中のセッションだけを閉じる。ログインし終えたセッションは閉じない
  // （ほかの人がその利用者名で失敗を重ねても、使っている職員を締め出さない。一時停止の間は、パスワードを確かめる
  // 操作（ロックの解除・再認証・パスワードの変更）を断る。2026-10-18 に承認者が決めた。docs/spec.md の 3.6）
  await ctx.db.session.deleteMany({ where: { userId: user.id, stage: { not: "active" } } });
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
 * 画面のロックの解除・再認証・パスワードの変更に使う。回数の上限と一時停止を、ログインと同じに数える。
 * requireTotp が false なら（画面のロックの解除で SCREEN_UNLOCK_REQUIRE_TOTP=false のとき）、TOTP は確かめず、
 * 送られた番号も使った段に数えない。TOTP を確かめたら true を返す
 */
async function verifyAgain(
  ctx: AuthContext,
  user: User,
  input: { password?: string; code?: string },
  action: AuditAction,
  options: { requireTotp?: boolean } = {},
): Promise<boolean> {
  const checkTotp = (options.requireTotp ?? true) && user.totpSecretEnc !== null;
  // 回数は利用者ごとの試みの枠で抑える（全体の枠に入れると、ほかの人のログインの要求でロック中の職員が戻れなくなる）
  if (!(await claimAttempt(ctx, user))) {
    await record(ctx, actorOf(user), { action, outcome: "denied", detail: { reason: "locked" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE, ["locked"]);
  }
  // ログインした人の枠で回す（ログインの要求が溢れていても、ロック中の職員が戻れるように）。
  // 混んで断ったときは、取った試みの枠を返す（混んでいたことを失敗に数えない）
  let passwordOk: boolean;
  try {
    passwordOk = await hashing(ctx, "priority", () => verifyPassword(input.password ?? "", user.passwordHash));
  } catch (error) {
    await releaseAttempt(ctx, user);
    throw error;
  }
  let totpOk = true;
  if (passwordOk && checkTotp) {
    const secret = totpSecretOf(ctx, user);
    totpOk = secret !== null && (await acceptTotp(ctx, user, secret, input.code ?? ""));
  }
  if (!passwordOk || !totpOk) {
    const locked = await registerFailure(ctx, user, passwordOk ? "bad_totp" : "bad_password", action);
    throw new AuthFailure(401, checkTotp ? "パスワードか確認の番号が違う" : "パスワードが違う", locked ? ["locked"] : []);
  }
  await resetAttempts(ctx, user);
  return checkTotp;
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

/**
 * ログイン（利用者名とパスワード）。previousToken は、このブラウザがいま持っているセッションの token
 * （ログインし直したら、前のセッションを消す）
 */
export async function login(
  ctx: AuthContext,
  rawUsername: string,
  password: string,
  previousToken?: string,
): Promise<LoginResult> {
  const { throttled } = await throttleLogin(ctx, rawUsername);
  // 失敗の答えは、ここから決めた時間（LOGIN_FAILURE_FLOOR_MS）より前には返さない（利用者名の有無で、
  // データベースの仕事の量が違うため。測った差は docs/spec.md の 3.6）
  const started = performance.now();
  // 遅らせの数え方と同じ正規化（NFKC・小文字・空白の除去）で利用者を引く
  const username = normalizeUsername(rawUsername);
  const user = isValidUsername(username) ? await ctx.db.user.findUnique({ where: { username } }) : null;

  // パスワードの確かめは、どの道でも1回だけ、ログインの枠で回す（枠と待ちの席が埋まっていれば 503）
  const check = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await limiterOf(ctx).run("login", fn);
    } catch (error) {
      if (error instanceof HashBusyError) {
        digestOf(ctx).add(user ? actorOf(user) : UNKNOWN_ACTOR, "busy", now(ctx));
        throw busyFailure();
      }
      throw error;
    }
  };
  const deny = async (actor: DigestActor, reason: string): Promise<never> => {
    await recordLoginDenied(ctx, actor, reason, throttled);
    await padUntil(started + (ctx.loginFailureFloorMs ?? LOGIN_FAILURE_FLOOR_MS));
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  };

  if (!user) {
    // 知らない利用者名でも、パスワードの確かめと同じほどの時間をかけ、同じ答えを返す。
    // 名前は、打ち間違えたパスワードであることがあるので、記録に入れない
    await check(() => burnPasswordCheck(password));
    return deny(UNKNOWN_ACTOR, "unknown_user");
  }
  if (user.status !== "active") {
    await check(() => burnPasswordCheck(password));
    return deny(actorOf(user), "disabled");
  }
  if (!(await claimAttempt(ctx, user))) {
    await check(() => burnPasswordCheck(password));
    return deny(actorOf(user), "locked");
  }
  let passwordOk: boolean;
  try {
    passwordOk = await check(() => verifyPassword(password, user.passwordHash));
  } catch (error) {
    // 混んで断ったときは、取った試みの枠を返す（混んでいたことを失敗に数えない）
    await releaseAttempt(ctx, user);
    throw error;
  }
  if (!passwordOk) {
    await registerFailure(ctx, user, "bad_password", "login", throttled);
    await padUntil(started + (ctx.loginFailureFloorMs ?? LOGIN_FAILURE_FLOOR_MS));
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  await releaseAttempt(ctx, user);

  // 平文はここでしか見られないので、ここで2つを確かめる（TOTP の段を通る利用者にも効く）：
  // - いまの規則に合わなくなったパスワード（MFA_REQUIRED を false にしたときの 8〜12 文字など）は、本人が変える。
  // - 保存したハッシュが、いまの強さより弱ければ作り直す（混んでいれば、次のログインに回す）。
  //   作り直しは、パスワードが同時に変えられていないとき（passwordHash が読んだ値のまま）だけ書く
  const data: { mustChangePassword?: true; passwordHash?: string } = {};
  if (
    !user.mustChangePassword &&
    checkPassword(password, { mfaRequired: ctx.settings.mfaRequired, username: user.username }).length > 0
  ) {
    data.mustChangePassword = true;
  }
  if (needsRehash(user.passwordHash)) {
    try {
      data.passwordHash = await limiterOf(ctx).run("login", () => hashPassword(password));
    } catch (error) {
      if (!(error instanceof HashBusyError)) throw error;
    }
  }
  let current = user;
  if (Object.keys(data).length > 0) {
    const res = await ctx.db.user.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash },
      data: { ...data, updatedAt: now(ctx) },
    });
    if (res.count !== 1) return deny(actorOf(user), "changed_during_login");
    current = { ...user, ...data };
  }

  if (previousToken && previousToken.length <= 128) {
    await ctx.db.session.deleteMany({ where: { id: hashToken(previousToken) } });
  }
  const stage = nextStageAfterPassword(ctx, current);
  const result = await openSession(ctx, current, stage);
  if (stage === "active") await completeLogin(ctx, current, { mfa: false });
  return result;
}

/**
 * セッションを開く。確かめている間にパスワードを変えた・TOTP をやり直した・止めた・一時停止にした利用者の
 * セッションを、後から生き残らせない。
 *
 * データベースの transaction の隔たりには頼らない（Prisma の SQLite の adapter は1つのつなぎを使い、
 * transaction の途中にほかの要求の文が入りうるため。わざと取り消すと、その文まで消える）。代わりに
 * 「作ってから確かめ、違えば消す」の順にする：利用者を変える操作（止める・一時停止・TOTP のやり直し・
 * パスワードの変更）は、どれも利用者の行を変えた後にセッションを消すので、
 * - 変更が、下の確かめより前なら、確かめで見つけて、作ったセッションを消す。
 * - 変更が、下の確かめより後なら、その操作の後のセッションの削除が、作ったセッションも消す。
 * replacing を渡したら、そのセッション（ログインの途中のセッション）を先に消し、消せたとき（1件）だけ作る
 * （ほかの画面で先に進んだ・閉じた途中のセッションから、二度ログインさせない）
 */
async function openSession(
  ctx: AuthContext,
  user: User,
  stage: Stage,
  options: { replacing?: string } = {},
): Promise<LoginResult> {
  const at = now(ctx);
  const token = randomBytes(32).toString("base64url");
  const id = hashToken(token);
  const expiresAt =
    stage === "active"
      ? addMinutes(at, ctx.settings.sessionMaxHours * 60)
      : addMinutes(at, ctx.settings.pendingSessionMinutes);
  if (options.replacing !== undefined) {
    const gone = await ctx.db.session.deleteMany({ where: { id: options.replacing, userId: user.id } });
    if (gone.count !== 1) throw new AuthFailure(409, SESSION_GONE_MESSAGE);
  }
  await ctx.db.session.create({
    data: {
      id,
      userId: user.id,
      stage,
      csrfToken: randomBytes(32).toString("base64url"),
      createdAt: at,
      expiresAt,
      lastActivityAt: at,
      // 確かめた時の認証の世代。その後にパスワードの変更・TOTP の登録・やり直しがあれば、resolveSession が使わせない
      credentialVersion: user.credentialVersion,
    },
  });
  const fresh = await ctx.db.user.findUnique({ where: { id: user.id } });
  if (
    !fresh ||
    fresh.status !== "active" ||
    (fresh.lockedUntil !== null && fresh.lockedUntil > at) ||
    fresh.credentialVersion !== user.credentialVersion ||
    fresh.passwordChangedAt.getTime() !== user.passwordChangedAt.getTime() ||
    fresh.totpSecretEnc !== user.totpSecretEnc
  ) {
    await ctx.db.session.deleteMany({ where: { id } });
    await record(ctx, actorOf(user), { action: "login", outcome: "denied", detail: { reason: "changed_during_login" } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE);
  }
  return { token, stage, expiresAt };
}

/**
 * 認証の世代を上げた後の、その利用者のほかのセッションの後片付け。世代が違うセッションは resolveSession が
 * 使わせないので、ここで消せなくても（止まった・失敗した）古いセッションは使えない。失敗しても操作は止めない
 */
async function closeOtherSessions(ctx: AuthContext, userId: string, keepId?: string): Promise<void> {
  try {
    await ctx.db.session.deleteMany({ where: { userId, ...(keepId ? { id: { not: keepId } } : {}) } });
  } catch (error) {
    console.error("tsunagi-dicom: 古いセッションの片付けに失敗した（認証の世代が違うので、使えない）", error);
  }
}

/** いまのセッションを、上げた後の認証の世代に合わせる（上げる前の世代のままのときだけ） */
async function followVersion(ctx: AuthContext, session: SessionRow, from: number, extra: { pendingTotpEnc?: null } = {}) {
  await ctx.db.session.updateMany({
    where: { id: session.id, credentialVersion: from },
    data: { credentialVersion: from + 1, ...extra },
  });
}

/**
 * 途中のセッションがまだ使える（残っていて、同じ段で、期限の前）という条件。利用者の行を変える
 * 1つの文（updateMany）の where に入れて、確かめと書き込みを分けない
 */
const liveSession = (session: SessionRow, user: Pick<User, "credentialVersion">, at: Date) => ({
  sessions: {
    some: { id: session.id, stage: session.stage, expiresAt: { gt: at }, credentialVersion: user.credentialVersion },
  },
});

async function completeLogin(ctx: AuthContext, user: User, detail: Record<string, unknown>) {
  const at = now(ctx);
  await resetAttempts(ctx, user);
  await ctx.db.user.update({ where: { id: user.id }, data: { lastLoginAt: at, updatedAt: at } });
  await record(ctx, actorOf(user), { action: "login", outcome: "success", detail });
}

/**
 * 段を進める。active になるときは、途中のセッションを消して、新しい token・CSRF の token のセッションを開く
 * （途中の段の token を、ログインした後に使い続けない）。そしてログインを記録する。
 * 途中のセッションが、もう無い・ほかの段に進んでいるときは 409（同じ途中のセッションから二度進ませない）。
 * user は、この段で確かめたときの利用者（openSession が、確かめた時のままかを見る）
 */
async function advance(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  stage: Stage,
  detail: Record<string, unknown>,
): Promise<StageResult> {
  if (stage !== "active") {
    const res = await ctx.db.session.updateMany({
      where: { id: session.id, stage: session.stage },
      data: { stage, pendingTotpEnc: null, lastActivityAt: now(ctx) },
    });
    if (res.count !== 1) throw new AuthFailure(409, SESSION_GONE_MESSAGE);
    return { stage };
  }
  const opened = await openSession(ctx, user, "active", { replacing: session.id });
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
    // 6 桁は総当たりされやすいので、1回の失敗で、この途中のセッションを捨てる（次の番号を試すには、
    // パスワードからログインし直す。どちらの失敗も、同じ一時停止の数え上げに入る）
    await ctx.db.session.deleteMany({ where: { id: session.id } });
    throw new AuthFailure(401, LOGIN_FAILED_MESSAGE, locked ? ["locked", SESSION_CLOSED] : [SESSION_CLOSED]);
  }
  // 確かめたときの利用者のままかは、advance（openSession）が見る
  return advance(ctx, session, user, user.mustChangePassword ? "change_password" : "active", { mfa: true });
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
 * （離れた端末のセッションで、ほかの人の認証のアプリを結び付けられないように）。
 * 書くのは、まだ TOTP を登録していない（totpSecretEnc が空の）ときだけ。もう登録してあれば 409
 * （登録の途中のセッションを2つ開いて、後から登録済みの TOTP を上書きできないように）。
 * 登録できたら、同じ transaction で、その利用者のほかのセッションを閉じる
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
  const enrolled = {
    totpSecretEnc: sealField(secret, ctx.settings.sessionSecret, user.id),
    totpEnabledAt: at,
    totpLastStep: step,
    updatedAt: at,
  };
  // 確かめと書き込みを1つの文にする：まだ登録していない・有効・パスワードが読んだ時のまま・この途中の
  // セッションがまだ使える（残っていて、同じ段で、期限の前）ときだけ書く
  // 書けたら、認証の世代を1つ上げる（ほかのセッションは、消す前でも使えなくなる）
  const res = await ctx.db.user.updateMany({
    where: {
      id: user.id,
      status: "active",
      totpSecretEnc: null,
      passwordChangedAt: user.passwordChangedAt,
      credentialVersion: user.credentialVersion,
      ...liveSession(session, user, at),
    },
    data: { ...enrolled, credentialVersion: { increment: 1 } },
  });
  if (res.count !== 1) {
    const current = await ctx.db.user.findUnique({ where: { id: user.id } });
    const reason = current?.totpSecretEnc ? "already_enrolled" : "session_gone";
    await record(ctx, actorOf(user), { action: "mfa_enroll", outcome: "denied", detail: { reason } });
    throw new AuthFailure(
      409,
      reason === "already_enrolled"
        ? "TOTP はもう登録してある。登録し直すときは、管理者に TOTP のやり直しを頼む"
        : SESSION_GONE_MESSAGE,
    );
  }
  // いまのセッションを新しい世代に合わせ（パスワードの変更の段に進むときも、この途中のセッションを使い続ける）、
  // ほかのセッションを片付ける
  await followVersion(ctx, session, user.credentialVersion, optional ? { pendingTotpEnc: null } : {});
  await closeOtherSessions(ctx, user.id, session.id);
  const updated: User = { ...user, ...enrolled, credentialVersion: user.credentialVersion + 1 };
  await record(ctx, actorOf(user), { action: "mfa_enroll", outcome: "success" });
  if (optional) return { stage: "active" };
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
  if (await hashing(ctx, "priority", () => verifyPassword(input.newPassword, user.passwordHash))) {
    problems.push("いまのパスワードと違うものにする");
  }
  if (problems.length > 0) throw new AuthFailure(400, "このパスワードは使えない", problems);

  const at = now(ctx);
  const changes = {
    passwordHash: await hashing(ctx, "priority", () => hashPassword(input.newPassword)),
    passwordChangedAt: at,
    mustChangePassword: false,
    updatedAt: at,
  };
  // 確かめと書き込みを1つの文にする：有効・パスワードと TOTP の秘密と認証の世代が読んだ時のまま・この
  // セッションがまだ使える（残っていて、同じ段で、期限の前）ときだけ変え、認証の世代を1つ上げる。
  // 世代を上げた時点で、ほかのセッション（同時に進んでいた古いパスワードのログインも）は使えなくなる
  const res = await ctx.db.user.updateMany({
    where: {
      id: user.id,
      status: "active",
      passwordChangedAt: user.passwordChangedAt,
      totpSecretEnc: user.totpSecretEnc,
      credentialVersion: user.credentialVersion,
      ...liveSession(session, user, at),
    },
    data: { ...changes, credentialVersion: { increment: 1 } },
  });
  if (res.count !== 1) {
    await record(ctx, actorOf(user), { action: "password_change", outcome: "denied", detail: { reason: "changed_during_change" } });
    throw new AuthFailure(409, "パスワードを変えられない（ほかの画面で先に変えたか、このセッションはもう使えない）。頁を開き直す");
  }
  if (session.stage === "active") await followVersion(ctx, session, user.credentialVersion);
  await closeOtherSessions(ctx, user.id, session.id);
  const updated: User = { ...user, ...changes, credentialVersion: user.credentialVersion + 1 };
  await record(ctx, actorOf(user), { action: "password_change", outcome: "success" });
  if (session.stage === "active") return { stage: "active" };
  return advance(ctx, session, updated, "active", { mfa: user.totpSecretEnc !== null, passwordChanged: true });
}

// ── 再認証（大事な操作の前の、もう一度の本人の確かめ） ──

/** パスワードと TOTP で本人を確かめ、設定の reauthMinutes の間、大事な操作を許す */
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

/**
 * 大事な操作（利用者の管理）の前に呼ぶ。設定の reauthMinutes（既定 REAUTH_MINUTES）の中に再認証していなければ
 * 403（problems に REAUTH_REQUIRED）。ログインの一時停止の間は、再認証の有効時間の内でも 403（problems に locked）
 * （一時停止の間は再認証を止める、という承認者の決定に合わせ、前に通した再認証も使わせない）
 */
export function assertRecentReauth(ctx: AuthContext, session: SessionRow, user: Pick<User, "lockedUntil">): void {
  const at = now(ctx).getTime();
  if (user.lockedUntil !== null && user.lockedUntil.getTime() > at) {
    throw new AuthFailure(403, "ログインの一時停止の間は、この操作はできない（一時停止が解けてから、もう一度確かめる）", ["locked"]);
  }
  if (session.reauthAt && at - session.reauthAt.getTime() < ctx.settings.reauthMinutes * 60_000) return;
  throw new AuthFailure(403, "この操作の前に、パスワード（と確認の番号）をもう一度入れる", [REAUTH_REQUIRED]);
}

// ── セッション ──

export type ResolvedSession =
  | { kind: "anonymous" }
  | { kind: "pending" | "locked" | "active"; session: SessionRow; user: User };

/**
 * cookie の token からセッションを引く。ロックはサーバーの側を正にし、次のどちらでも、この要求の時点でロックにする：
 * - lockRequested：画面が置いたロックの印（src/lib/auth/lock-cookie.ts）。画面のロックの知らせが届かなかったときも効く。
 * - 画面が最後に操作を知らせてから SCREEN_LOCK_MINUTES を過ぎた。
 * 認証の世代が違うセッションは使わない
 */
export async function resolveSession(
  ctx: AuthContext,
  token: string | undefined,
  options: { lockRequested?: "manual" | "client_idle" | null } = {},
): Promise<ResolvedSession> {
  if (!token || token.length > 128) return { kind: "anonymous" };
  const row = await ctx.db.session.findUnique({ where: { id: hashToken(token) }, include: { user: true } });
  if (!row) return { kind: "anonymous" };
  const { user, ...session } = row;
  const at = now(ctx);
  const userLocked = user.lockedUntil !== null && user.lockedUntil > at;
  // 認証の世代が違う（作った後にパスワードの変更・TOTP の登録・やり直しがあった）セッションは使わない。
  // ほかのセッションの削除が止まった・失敗したときも、ここで閉じる側に倒れる
  const staleCredential = session.credentialVersion !== user.credentialVersion;
  // 一時停止の間は、ログインの途中のセッションだけを使わせない（ログインし終えたセッションは使える）
  const pendingWhileLocked = userLocked && session.stage !== "active";
  if (session.expiresAt <= at || user.status !== "active" || pendingWhileLocked || staleCredential) {
    await ctx.db.session.deleteMany({ where: { id: session.id } });
    return { kind: "anonymous" };
  }
  if (session.stage !== "active") return { kind: "pending", session, user };
  if (session.lockedAt) return { kind: "locked", session, user };
  if (options.lockRequested) {
    const locked = await lockScreen(ctx, session, user, options.lockRequested);
    return { kind: "locked", session: locked, user };
  }

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

/**
 * 期限の切れたセッションを片付ける（Session_expiresAt_idx を使う）。起動の時と、一定の間隔で呼ぶ（src/lib/startup.ts）。
 * 切れたセッションは、片付ける前でも resolveSession が使わせない。消した数を返す
 */
export async function purgeExpiredSessions(db: Db, at: Date = new Date()): Promise<number> {
  const res = await db.session.deleteMany({ where: { expiresAt: { lte: at } } });
  return res.count;
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

/**
 * ロックを解く。既定はパスワードだけ（席を外した間の覗き見を防ぐロックで、確かめるのはログインした本人が戻ったか。
 * 二要素はログインで済んでいる）。SCREEN_UNLOCK_REQUIRE_TOTP=true なら、登録していれば TOTP も求める。
 * 失敗はログインの失敗と同じに数える（docs/spec.md の 3.6。2026-10-19 に承認者が決めた）
 */
export async function unlockScreen(
  ctx: AuthContext,
  session: SessionRow,
  user: User,
  input: { password: string; code?: string },
): Promise<void> {
  if (session.stage !== "active") throw new AuthFailure(409, "ログインしていない");
  const totp = await verifyAgain(ctx, user, input, "screen_unlock", { requireTotp: ctx.settings.screenUnlockRequireTotp });
  const at = now(ctx);
  await ctx.db.session.update({ where: { id: session.id }, data: { lockedAt: null, lastActivityAt: at } });
  await record(ctx, actorOf(user), { action: "screen_unlock", outcome: "success", detail: { totp } });
}

/** 画面のロックを解くときに、この利用者に TOTP を求めるか（解く画面に6桁の欄を出すか） */
export function screenUnlockNeedsTotp(settings: Pick<AuthSettings, "screenUnlockRequireTotp">, user: Pick<User, "totpSecretEnc">): boolean {
  return settings.screenUnlockRequireTotp && user.totpSecretEnc !== null;
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

const NO_ADMIN_LEFT = "有効な管理者が1人もいなくなるので、変えられない";

/** 有効な管理者が1人もいなくなる変更か */
async function wouldLoseLastAdmin(db: Tx, target: User, change: UserChange): Promise<boolean> {
  const losesAdmin =
    target.role === "admin" &&
    target.status === "active" &&
    ((change.role !== undefined && change.role !== "admin") || change.status === "disabled");
  if (!losesAdmin) return false;
  const others = await db.user.count({ where: { role: "admin", status: "active", id: { not: target.id } } });
  return others === 0;
}

export async function updateUser(
  ctx: AuthContext,
  targetId: string,
  change: UserChange,
  by: { actorId: string; actorRole: string },
): Promise<User> {
  const target = await ctx.db.user.findUnique({ where: { id: targetId } });
  if (!target) throw new AuthFailure(404, "利用者が無い");
  // 自分の一時停止は、一時停止の有無に関わらず自分では解けない（別の管理者が解く）
  if (change.clearLoginLock && target.username === by.actorId) {
    throw new AuthFailure(403, "自分のログインの一時停止は、自分では解けない。別の管理者が解く");
  }
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
    // （2人の管理者が同時に互いを外しても、0 人にしない。transaction どうしは一列に並ぶ）。
    // 断るときも transaction の中で例外を投げない（取り消すと、同じつなぎに入ったほかの要求の文まで消えうるため。
    // 何も書かずに終え、外で断る）
    const updated = await ctx.db.$transaction(async (tx) => {
      const fresh = await tx.user.findUniqueOrThrow({ where: { id: target.id } });
      if (await wouldLoseLastAdmin(tx, fresh, change)) return null;
      return tx.user.update({
        where: { id: target.id },
        data: {
          ...(roleChanged ? { role: change.role } : {}),
          ...(statusChanged ? { status: change.status } : {}),
          updatedAt: at,
        },
      });
    });
    if (!updated) throw new AuthFailure(409, NO_ADMIN_LEFT);
    user = updated;
  } else if (await wouldLoseLastAdmin(ctx.db, target, change)) {
    throw new AuthFailure(409, NO_ADMIN_LEFT);
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
      // 認証の世代を上げ、その利用者のセッションを、消す前でも使えなくする（削除は後片付け）
      data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, credentialVersion: { increment: 1 }, updatedAt: at },
    });
    await closeOtherSessions(ctx, target.id);
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
