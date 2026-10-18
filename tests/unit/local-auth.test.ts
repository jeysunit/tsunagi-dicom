import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/lib/audit";
import { bootstrapInitialAdmin, BootstrapError } from "@/lib/auth/bootstrap";
import { DEFAULT_ARGON2_PARAMS, hashPassword } from "@/lib/auth/password-hash";
import {
  AuthFailure,
  changePassword,
  confirmEnrollment,
  createUser,
  flushFailureDigest,
  HASH_BUSY_MESSAGE,
  hashToken,
  purgeExpiredSessions,
  SESSION_CLOSED,
  SESSION_GONE_MESSAGE,
  listUsers,
  lockScreen,
  login,
  logout,
  reauthenticate,
  PENDING_SESSION_MINUTES,
  REAUTH_MINUTES,
  REAUTH_REQUIRED,
  SESSION_MAX_HOURS,
  assertRecentReauth,
  resolveSession,
  SERVER_LOCK_GRACE_SECONDS,
  startEnrollment,
  submitTotp,
  unlockScreen,
  updateUser,
  type AuthContext,
  type AuthSettings,
} from "@/lib/auth/local-auth";
import { FailureDigest } from "@/lib/auth/failure-digest";
import { HASH_BUSY_RETRY_AFTER_SECONDS, HashLimiter, type HashLane } from "@/lib/auth/hash-limiter";
import { BUCKETS, LoginThrottle, MAX_DELAY_MS, normalizeUsername } from "@/lib/auth/rate-limit";
import { sealField } from "@/lib/auth/sealed-field";
import { totpAt } from "@/lib/auth/totp";
import type { Db } from "@/lib/db";
import { testDatabases } from "./helpers/test-db";

// AUTH_MODE=local の中身（docs/spec.md の 3.6）を、migration を流した本物の SQLite に対して確かめる。
// 時計は差し替える（一時停止・画面のロックの時間を待たない）。

const dbs = testDatabases("tsunagi-auth-");
beforeAll(() => dbs.setup(), 60_000);
afterEach(() => dbs.closeAll());
afterAll(() => dbs.teardown());

const SESSION_SECRET = "s".repeat(48);
const PASSWORD = "kq7vz2mw-pass";
const NEW_PASSWORD = "zr4tx8pe-next";
const ADMIN = { actorId: "system", actorRole: "none" };

class Clock {
  constructor(public t = new Date("2026-10-18T09:00:00Z").getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

/** 遅らせた時間（sleep の差し替えが控える） */
let slept: number[] = [];

async function setup(settings: Partial<AuthSettings> = {}) {
  slept = [];
  const db = await dbs.fresh();
  const clock = new Clock();
  const ctx: AuthContext = {
    db,
    settings: {
      mfaRequired: true,
      loginLockThreshold: 3,
      loginLockMinutes: 15,
      screenLockMinutes: 15,
      screenUnlockRequireTotp: false,
      sessionSecret: SESSION_SECRET,
      rateLimitPerUserPerMinute: 1000,
      rateLimitGlobalPerMinute: 1000,
      passwordHashConcurrency: 2,
      passwordHashQueue: 1000,
      pendingSessionMinutes: PENDING_SESSION_MINUTES,
      sessionMaxHours: SESSION_MAX_HOURS,
      reauthMinutes: REAUTH_MINUTES,
      ...settings,
    },
    source: { sourceAddress: null, sourceAddressUnverified: "198.51.100.7" },
    now: clock.now,
    loginThrottle: new LoginThrottle(),
    sleep: async (ms: number) => {
      slept.push(ms);
    },
    failureDigest: new FailureDigest(),
    // 失敗の答えの下限は、それを見る試験でだけ使う（ほかの試験を遅くしない）
    loginFailureFloorMs: 0,
  };
  ctx.hashLimiter = new HashLimiter({ concurrency: ctx.settings.passwordHashConcurrency, queueLimit: ctx.settings.passwordHashQueue });
  return { db, ctx, clock };
}

async function sessionOf(db: Db, token: string) {
  const row = await db.session.findUniqueOrThrow({ where: { id: hashToken(token) }, include: { user: true } });
  const { user, ...session } = row;
  return { session, user };
}

async function auditRows(db: Db) {
  return db.auditLog.findMany({ orderBy: { seq: "asc" } });
}

/** TOTP を登録した利用者を作り、その秘密を返す */
async function enrolledUser(ctx: AuthContext, clock: Clock, username = "tanaka", role: "doctor" | "admin" = "doctor") {
  await createUser(ctx, { username, displayName: "田中", role, password: PASSWORD, mustChangePassword: false }, ADMIN);
  const first = await login(ctx, username, PASSWORD);
  expect(first.stage).toBe("enroll");
  const { session, user } = await sessionOf(ctx.db, first.token);
  const { secret } = await startEnrollment(ctx, session, user);
  const s2 = await sessionOf(ctx.db, first.token);
  const done = await confirmEnrollment(ctx, s2.session, s2.user, totpAt(secret, clock.t));
  expect(done.stage).toBe("active");
  // 次の TOTP は次の段で（使い回しは断る）
  clock.advance(30_000);
  // ログインし終えたら、新しい token のセッションに替わる
  return { secret, token: done.rotated!.token };
}

describe("利用者を作る", () => {
  it("パスワードの規則に合わないものは作らない", async () => {
    const { ctx } = await setup();
    await expect(
      createUser(ctx, { username: "tanaka", displayName: "田中", role: "doctor", password: "password1", mustChangePassword: true }, ADMIN),
    ).rejects.toMatchObject({ status: 400, problems: [expect.stringContaining("よく使われる")] });
    await expect(
      createUser(ctx, { username: "Ta Naka", displayName: "", role: "doctor", password: PASSWORD, mustChangePassword: true }, ADMIN),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("パスワードは argon2id のハッシュで持ち、作ったことを記録に残す（パスワードは記録しない）", async () => {
    const { ctx, db } = await setup();
    const user = await createUser(
      ctx,
      { username: "tanaka", displayName: "田中", role: "doctor", password: PASSWORD, mustChangePassword: true },
      ADMIN,
    );
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(PASSWORD);
    const rows = await auditRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "user_create", actorId: "system", authMode: "local" });
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
    await expect(
      createUser(ctx, { username: "tanaka", displayName: "別", role: "viewer", password: PASSWORD, mustChangePassword: true }, ADMIN),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe("ログインと二要素（TOTP）", () => {
  it("MFA_REQUIRED=true で未登録なら、登録の段に進む。登録した後は TOTP の段を通ってログインする", async () => {
    const { ctx, db, clock } = await setup();
    const { secret } = await enrolledUser(ctx, clock);

    const second = await login(ctx, "tanaka", PASSWORD);
    expect(second.stage).toBe("totp");
    const pending = await sessionOf(db, second.token);
    // 途中のセッションは、ログインしたものとしては使えない
    expect((await resolveSession(ctx, second.token)).kind).toBe("pending");
    const done = await submitTotp(ctx, pending.session, pending.user, totpAt(secret, clock.t));
    expect(done.stage).toBe("active");
    // 途中の段の token は使えなくなり、新しい token・CSRF の token のセッションに替わる
    expect(done.rotated!.token).not.toBe(second.token);
    expect((await resolveSession(ctx, second.token)).kind).toBe("anonymous");
    const rotated = await resolveSession(ctx, done.rotated!.token);
    expect(rotated.kind).toBe("active");
    expect(rotated.kind === "active" && rotated.session.csrfToken).not.toBe(pending.session.csrfToken);

    const user = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    expect(user.lastLoginAt).toEqual(clock.now());
    expect(user.totpSecretEnc).not.toContain(secret);
    const actions = (await auditRows(db)).map((r) => `${r.action}:${r.outcome}`);
    expect(actions).toEqual(["user_create:success", "mfa_enroll:success", "login:success", "login:success"]);
  });

  it("同じ確認の番号（同じ段）の使い回しを断る", async () => {
    const { ctx, db, clock } = await setup();
    const { secret } = await enrolledUser(ctx, clock);
    const code = totpAt(secret, clock.t);
    const a = await login(ctx, "tanaka", PASSWORD);
    const sa = await sessionOf(db, a.token);
    expect((await submitTotp(ctx, sa.session, sa.user, code)).stage).toBe("active");
    const b = await login(ctx, "tanaka", PASSWORD);
    const sb = await sessionOf(db, b.token);
    await expect(submitTotp(ctx, sb.session, sb.user, code)).rejects.toMatchObject({ status: 401 });
  });

  it("MFA_REQUIRED=false なら、未登録でもパスワードだけでログインする（パスワードは 13 文字以上）", async () => {
    const { ctx } = await setup({ mfaRequired: false });
    await expect(
      createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw", mustChangePassword: false }, ADMIN),
    ).rejects.toMatchObject({ problems: ["パスワード：13 文字以上にする"] });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    expect((await login(ctx, "sato", "kq7vz2mw-long1")).stage).toBe("active");
  });

  it("管理者が決めたパスワードは、最初のログインで本人が変える（いまと同じもの・規則に合わないものは断る）", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    const pw = "kq7vz2mw-long1";
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: pw, mustChangePassword: true }, ADMIN);
    const r = await login(ctx, "sato", pw);
    expect(r.stage).toBe("change_password");
    const s = await sessionOf(db, r.token);
    await expect(changePassword(ctx, s.session, s.user, { newPassword: pw })).rejects.toMatchObject({ status: 400 });
    await expect(changePassword(ctx, s.session, s.user, { newPassword: "sato-kq7vz2mw-1" })).rejects.toMatchObject({ status: 400 });
    expect((await changePassword(ctx, s.session, s.user, { newPassword: "zr4tx8pe-next-1" })).stage).toBe("active");
    expect((await db.user.findUniqueOrThrow({ where: { username: "sato" } })).mustChangePassword).toBe(false);
    await expect(login(ctx, "sato", pw)).rejects.toBeInstanceOf(AuthFailure);
    expect((await login(ctx, "sato", "zr4tx8pe-next-1")).stage).toBe("active");
  });

  it("知らない利用者名・止めた利用者は、同じ文言で断り、記録に残す（知らない利用者名そのものは記録しない）", async () => {
    const { ctx, db } = await setup();
    await createUser(ctx, { username: "tanaka", displayName: "田中", role: "doctor", password: PASSWORD, mustChangePassword: false }, ADMIN);
    const e1 = await login(ctx, "nobody", PASSWORD).catch((e: unknown) => e);
    const user = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    await updateUser(ctx, user.id, { status: "disabled" }, ADMIN);
    const e2 = await login(ctx, "tanaka", PASSWORD).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(AuthFailure);
    expect(e2).toBeInstanceOf(AuthFailure);
    expect((e1 as Error).message).toBe((e2 as Error).message);
    const rows = await auditRows(db);
    expect(rows.find((r) => r.detail?.includes("unknown_user"))).toMatchObject({ actorId: "unknown", outcome: "denied" });
    expect(JSON.stringify(rows)).not.toContain("nobody");
    expect(rows.find((r) => r.action === "login" && r.detail?.includes("disabled"))).toMatchObject({ actorId: "tanaka", outcome: "denied" });
  });
});

describe("ログインの一時停止（第7.0版 14 遵守事項⑥(6)）", () => {
  it("決めた回数続けて失敗したら、決めた時間ログインできない。時間が過ぎたら戻る（永久には止めない）", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 3, loginLockMinutes: 15, mfaRequired: false });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    for (let i = 0; i < 3; i++) await expect(login(ctx, "sato", "wrong-pass-123")).rejects.toBeInstanceOf(AuthFailure);

    // 正しいパスワードでも、一時停止の間は断る
    await expect(login(ctx, "sato", "kq7vz2mw-long1")).rejects.toBeInstanceOf(AuthFailure);
    clock.advance(14 * 60_000);
    await expect(login(ctx, "sato", "kq7vz2mw-long1")).rejects.toBeInstanceOf(AuthFailure);
    clock.advance(60_000);
    expect((await login(ctx, "sato", "kq7vz2mw-long1")).stage).toBe("active");

    const rows = await auditRows(db);
    expect(rows.filter((r) => r.action === "login_lock")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "login" && r.detail?.includes("locked"))).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("wrong-pass-123");
    expect(JSON.stringify(rows)).not.toContain("kq7vz2mw-long1");
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it("成功すると、失敗の数を0に戻す（「続けて」の失敗だけを数える）", async () => {
    const { ctx, db } = await setup({ loginLockThreshold: 3, mfaRequired: false });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    for (let i = 0; i < 2; i++) await expect(login(ctx, "sato", "wrong-pass-123")).rejects.toBeInstanceOf(AuthFailure);
    await login(ctx, "sato", "kq7vz2mw-long1");
    for (let i = 0; i < 2; i++) await expect(login(ctx, "sato", "wrong-pass-123")).rejects.toBeInstanceOf(AuthFailure);
    expect((await login(ctx, "sato", "kq7vz2mw-long1")).stage).toBe("active");
    expect((await db.user.findUniqueOrThrow({ where: { username: "sato" } })).lockedUntil).toBeNull();
  });

  // TOTP の1回の失敗で途中のセッションを捨てる（安全のレビューの指摘：6 桁の総当たり）ので、2回目はログインし直して試す
  it("TOTP の失敗も同じに数え、失敗した途中のセッションは捨てる。一時停止になる", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 2 });
    await enrolledUser(ctx, clock);
    const r = await login(ctx, "tanaka", PASSWORD);
    const s = await sessionOf(db, r.token);
    await expect(submitTotp(ctx, s.session, s.user, "000000")).rejects.toMatchObject({ problems: [SESSION_CLOSED] });
    expect((await resolveSession(ctx, r.token)).kind).toBe("anonymous");
    const r2 = await login(ctx, "tanaka", PASSWORD);
    const s2 = await sessionOf(db, r2.token);
    await expect(submitTotp(ctx, s2.session, s2.user, "000001")).rejects.toMatchObject({ problems: ["locked", SESSION_CLOSED] });
    expect((await resolveSession(ctx, r2.token)).kind).toBe("anonymous");
    const rows = await auditRows(db);
    expect(rows.filter((x) => x.action === "login" && x.detail?.includes("bad_totp"))).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("000001");
  });

  it("管理者は一時停止を解ける", async () => {
    const { ctx, db } = await setup({ loginLockThreshold: 1, mfaRequired: false });
    const u = await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    await expect(login(ctx, "sato", "wrong-pass-123")).rejects.toBeInstanceOf(AuthFailure);
    expect((await listUsers(ctx))[0]!.lockedUntil).not.toBeNull();
    await updateUser(ctx, u.id, { clearLoginLock: true }, ADMIN);
    expect((await login(ctx, "sato", "kq7vz2mw-long1")).stage).toBe("active");
    expect((await auditRows(db)).map((r) => r.action)).toContain("login_unlock");
  });
});

describe("画面のロック（第7.0版 12 遵守事項⑥）", () => {
  // 2026-10-19 に承認者が決めた：既定はパスワードだけで解き、SCREEN_UNLOCK_REQUIRE_TOTP=true のときだけ TOTP も求める。
  // この試験は、設定を true にしたときに、これまでどおりパスワードと TOTP が要ることを確かめる（期待は変えていない）
  it("SCREEN_UNLOCK_REQUIRE_TOTP=true：ロックしたら、解くまでセッションはロックのまま。解くにはパスワードと TOTP が要る", async () => {
    const { ctx, db, clock } = await setup({ screenUnlockRequireTotp: true });
    const { secret, token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "client_idle");
    expect((await resolveSession(ctx, token)).kind).toBe("locked");

    const locked = await sessionOf(db, token);
    await expect(unlockScreen(ctx, locked.session, locked.user, { password: PASSWORD })).rejects.toMatchObject({ status: 401 });
    await expect(
      unlockScreen(ctx, locked.session, locked.user, { password: "wrong-pass-123", code: totpAt(secret, clock.t) }),
    ).rejects.toMatchObject({ status: 401 });
    await unlockScreen(ctx, locked.session, locked.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    expect((await resolveSession(ctx, token)).kind).toBe("active");

    const actions = (await auditRows(db)).map((r) => `${r.action}:${r.outcome}`);
    expect(actions).toContain("screen_lock:success");
    expect(actions.filter((a) => a === "screen_unlock:denied")).toHaveLength(2);
    expect(actions).toContain("screen_unlock:success");
    expect(JSON.stringify(await auditRows(db))).not.toContain(PASSWORD);
    // 解いたことの記録に、TOTP を確かめたことを残す
    const unlocked = (await auditRows(db)).filter((r) => r.action === "screen_unlock" && r.outcome === "success");
    expect(unlocked.map((r) => JSON.parse(r.detail ?? "{}"))).toEqual([{ totp: true }]);
  });

  it("SCREEN_UNLOCK_REQUIRE_TOTP=true：番号が無い・違うときは断り、失敗に数える（理由 bad_totp）", async () => {
    const { ctx, db, clock } = await setup({ screenUnlockRequireTotp: true, loginLockThreshold: 2 });
    const { secret, token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    const count = async () => (await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).failedLoginCount;

    await expect(unlockScreen(ctx, s.session, s.user, { password: PASSWORD })).rejects.toMatchObject({ status: 401, problems: [] });
    expect(await count()).toBe(1);
    await expect(unlockScreen(ctx, s.session, s.user, { password: PASSWORD, code: "000000" })).rejects.toMatchObject({
      status: 401,
      problems: ["locked"],
    });
    expect((await resolveSession(ctx, token)).kind).toBe("locked");
    const denied = (await auditRows(db)).filter((r) => r.action === "screen_unlock" && r.outcome === "denied");
    expect(denied.map((r) => JSON.parse(r.detail ?? "{}").reason)).toEqual(["bad_totp", "bad_totp"]);
    // 一時停止の間は、正しいパスワードと番号でも解けない
    await expect(
      unlockScreen(ctx, s.session, s.user, { password: PASSWORD, code: totpAt(secret, clock.t) }),
    ).rejects.toMatchObject({ problems: ["locked"] });
  });

  it("SCREEN_UNLOCK_REQUIRE_TOTP=true でも、TOTP を登録していない利用者はパスワードだけで解く", async () => {
    const { ctx, db } = await setup({ mfaRequired: false, screenUnlockRequireTotp: true });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    await unlockScreen(ctx, s.session, s.user, { password: "kq7vz2mw-long1" });
    expect((await resolveSession(ctx, token)).kind).toBe("active");
  });

  it("既定（SCREEN_UNLOCK_REQUIRE_TOTP=false）：TOTP を登録した利用者も、パスワードだけで解ける。記録に TOTP を確かめなかったことを残す", async () => {
    const { ctx, db, clock } = await setup();
    const { token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "client_idle");
    expect((await resolveSession(ctx, token)).kind).toBe("locked");

    const locked = await sessionOf(db, token);
    await unlockScreen(ctx, locked.session, locked.user, { password: PASSWORD });
    expect((await resolveSession(ctx, token)).kind).toBe("active");

    const rows = await auditRows(db);
    const unlocked = rows.filter((r) => r.action === "screen_unlock");
    expect(unlocked.map((r) => [r.outcome, JSON.parse(r.detail ?? "{}")])).toEqual([["success", { totp: false }]]);
    expect(unlocked[0]!.actorId).toBe("tanaka");
    expect(JSON.stringify(rows)).not.toContain(PASSWORD);
  });

  it("既定：TOTP の番号を送っても要らない。違う番号でも解け、送った番号は使った段に数えない（ログインで使える）", async () => {
    const { ctx, db, clock } = await setup();
    const { secret, token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);

    // 違う番号を添えても、パスワードが合えば解ける
    await lockScreen(ctx, s.session, s.user, "manual");
    await unlockScreen(ctx, s.session, s.user, { password: PASSWORD, code: "000000" });
    expect((await resolveSession(ctx, token)).kind).toBe("active");

    // 正しい番号を添えても、確かめず、使った段を進めない
    const before = (await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).totpLastStep;
    const s2 = await sessionOf(db, token);
    await lockScreen(ctx, s2.session, s2.user, "manual");
    const code = totpAt(secret, clock.t);
    await unlockScreen(ctx, s2.session, s2.user, { password: PASSWORD, code });
    expect((await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).totpLastStep).toBe(before);
    // 同じ番号を、ログインの TOTP で使える（ロックの解除で使い切っていない）
    const r = await login(ctx, "tanaka", PASSWORD);
    const p = await sessionOf(db, r.token);
    expect((await submitTotp(ctx, p.session, p.user, code)).stage).toBe("active");

    const rows = await auditRows(db);
    expect(rows.filter((x) => x.action === "screen_unlock" && x.outcome === "denied")).toHaveLength(0);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it("既定：パスワードの誤りは失敗に数え（理由 bad_password）、決めた回数で一時停止になる。一時停止の間は正しいパスワードでも解けない", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 2 });
    const { token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    const user = async () => db.user.findUniqueOrThrow({ where: { username: "tanaka" } });

    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({
      status: 401,
      message: "パスワードが違う",
      problems: [],
    });
    expect((await user()).failedLoginCount).toBe(1);
    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({
      status: 401,
      problems: ["locked"],
    });
    expect((await user()).lockedUntil!.getTime()).toBeGreaterThan(clock.t);
    await expect(unlockScreen(ctx, s.session, s.user, { password: PASSWORD })).rejects.toMatchObject({
      status: 401,
      problems: ["locked"],
    });
    // セッションはロックのまま残る
    expect((await resolveSession(ctx, token)).kind).toBe("locked");
    const rows = await auditRows(db);
    const denied = rows.filter((r) => r.action === "screen_unlock" && r.outcome === "denied");
    expect(denied.map((r) => JSON.parse(r.detail ?? "{}").reason)).toEqual(["bad_password", "bad_password", "locked"]);
    expect(rows.filter((r) => r.action === "login_lock")).toHaveLength(1);

    // 一時停止が解けたら、同じセッションでパスワードだけで解ける（一時停止にしたときに数は0になっている。
    // 解除で取った枠は返すので、成功しても数は増えない）
    clock.advance(16 * 60_000);
    const later = await sessionOf(db, token);
    await unlockScreen(ctx, later.session, later.user, { password: PASSWORD });
    expect((await resolveSession(ctx, token)).kind).toBe("active");
    expect((await user()).failedLoginCount).toBe(0);
  });

  it("既定：TOTP を登録した利用者の、パスワードだけの解除の成功は、前の失敗の数を消さない（枠は返す）。TOTP まで確かめた成功で0に戻る", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 5 });
    const { secret, token } = await enrolledUser(ctx, clock);
    const count = async () => (await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).failedLoginCount;
    const lockAndUnlock = async () => {
      const s = await sessionOf(db, token);
      await lockScreen(ctx, s.session, s.user, "manual");
      const l = await sessionOf(db, token);
      await unlockScreen(ctx, l.session, l.user, { password: PASSWORD });
    };
    // 失敗が無ければ、何度解いても数は増えない（取った枠を返す）
    await lockAndUnlock();
    await lockAndUnlock();
    expect(await count()).toBe(0);
    // 解く前の失敗（パスワードの誤り）は、パスワードだけの解除の後も残る
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({ status: 401 });
    expect(await count()).toBe(1);
    const l = await sessionOf(db, token);
    await unlockScreen(ctx, l.session, l.user, { password: PASSWORD });
    expect(await count()).toBe(1);
    // 再認証（パスワードと TOTP）の成功で0に戻る
    const a = await sessionOf(db, token);
    await reauthenticate(ctx, a.session, a.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    expect(await count()).toBe(0);
  });

  it("既定：TOTP を登録していない利用者は、パスワードだけの解除の成功で失敗の数を0に戻す（持つ確かめの全部のため）", async () => {
    const { ctx, db } = await setup({ mfaRequired: false, loginLockThreshold: 5 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({ status: 401 });
    await unlockScreen(ctx, s.session, s.user, { password: "kq7vz2mw-long1" });
    expect((await db.user.findUniqueOrThrow({ where: { username: "sato" } })).failedLoginCount).toBe(0);
  });

  it("回帰（Codex の指摘）：再認証で TOTP を閾値の手前まで誤り、パスワードだけで解除することを繰り返しても、閾値で一時停止になる", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 3 });
    const { secret, token } = await enrolledUser(ctx, clock);
    clock.advance(30_000);
    const count = async () => (await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).failedLoginCount;
    const badTotp = async () => {
      const a = await sessionOf(db, token);
      return reauthenticate(ctx, a.session, a.user, { password: PASSWORD, code: "000000" });
    };
    const unlockWithPassword = async () => {
      const s = await sessionOf(db, token);
      // ロックしていなくても解除の要求は確かめる（断らない）。ロックしてから送っても同じ
      await lockScreen(ctx, s.session, s.user, "manual");
      const l = await sessionOf(db, token);
      await unlockScreen(ctx, l.session, l.user, { password: PASSWORD });
    };

    // 1巡目：閾値の手前（2回）まで TOTP を誤り、パスワードだけで解く
    await expect(badTotp()).rejects.toMatchObject({ status: 401, problems: [] });
    await expect(badTotp()).rejects.toMatchObject({ status: 401, problems: [] });
    expect(await count()).toBe(2);
    await unlockWithPassword();
    expect(await count()).toBe(2);
    // 2巡目：次の TOTP の誤りで閾値に届き、一時停止になる（解除で数は消えていない）
    await expect(badTotp()).rejects.toMatchObject({ status: 401, problems: ["locked"] });
    const locked = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(clock.t);
    // 一時停止の間は、正しい番号の再認証も、パスワードだけの解除も通らない
    const a = await sessionOf(db, token);
    await expect(
      reauthenticate(ctx, a.session, a.user, { password: PASSWORD, code: totpAt(secret, clock.t) }),
    ).rejects.toMatchObject({ problems: ["locked"] });
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    const l = await sessionOf(db, token);
    await expect(unlockScreen(ctx, l.session, l.user, { password: PASSWORD })).rejects.toMatchObject({ problems: ["locked"] });
    const rows = await auditRows(db);
    expect(rows.filter((r) => r.action === "login_lock")).toHaveLength(1);
    expect(rows.filter((r) => r.action === "reauth" && r.outcome === "denied").map((r) => JSON.parse(r.detail ?? "{}").reason)).toEqual([
      "bad_totp",
      "bad_totp",
      "bad_totp",
      "locked",
    ]);
  });

  it("既定でも、ログインと再認証の TOTP は求める（画面のロックの設定はほかの確かめに効かない）", async () => {
    const { ctx, db, clock } = await setup();
    const { secret, token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);
    await expect(reauthenticate(ctx, s.session, s.user, { password: PASSWORD })).rejects.toMatchObject({ status: 401 });
    await reauthenticate(ctx, s.session, s.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    expect((await login(ctx, "tanaka", PASSWORD)).stage).toBe("totp");
  });

  it("操作の無い時間が SCREEN_LOCK_MINUTES に達したら、サーバーの側でもその要求の時点でロックにする（猶予なし）", async () => {
    const { ctx, clock } = await setup({ mfaRequired: false, screenLockMinutes: 15 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    expect(SERVER_LOCK_GRACE_SECONDS).toBe(0);
    clock.advance(15 * 60_000 - 1000);
    expect((await resolveSession(ctx, token)).kind).toBe("active");
    clock.advance(1000);
    expect((await resolveSession(ctx, token)).kind).toBe("locked");
  });

  it("画面が置いたロックの印があれば、その要求の時点でロックにし、記録に残す（ロックの知らせが届かなくても）", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    expect((await resolveSession(ctx, token, { lockRequested: null })).kind).toBe("active");
    expect((await resolveSession(ctx, token, { lockRequested: "manual" })).kind).toBe("locked");
    // 印が無くなっても、BFF の側のロックは残る（解くにはパスワード）
    expect((await resolveSession(ctx, token)).kind).toBe("locked");
    const rows = await auditRows(db);
    expect(rows.filter((r) => r.action === "screen_lock")).toHaveLength(1);
  });

  it("SCREEN_LOCK_MINUTES=0 ならロックしない", async () => {
    const { ctx, clock } = await setup({ mfaRequired: false, screenLockMinutes: 0 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    clock.advance(11 * 60 * 60_000);
    expect((await resolveSession(ctx, token)).kind).toBe("active");
  });

  // 一時停止のときのセッションの扱いは、2026-10-18 に承認者が決めた（F3）：ログインし終えたセッションは閉じず、
  // ログインの途中のセッションだけを閉じる。一時停止の間は、パスワードを確かめる操作（ロックの解除・再認証）を断る
  it("解く失敗も一時停止に数える。一時停止の後もセッションはロックのまま残り、解除は一時停止が解けるまで断る", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false, loginLockThreshold: 2 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({ problems: [] });
    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({
      problems: ["locked"],
    });
    // セッションは閉じない（ロックのまま）。正しいパスワードでも、一時停止の間は解けない
    expect((await resolveSession(ctx, token)).kind).toBe("locked");
    const locked = await sessionOf(db, token);
    await expect(unlockScreen(ctx, locked.session, locked.user, { password: "kq7vz2mw-long1" })).rejects.toMatchObject({
      status: 401,
      problems: ["locked"],
    });
    expect((await resolveSession(ctx, token)).kind).toBe("locked");
    // 一時停止が解けたら、同じセッションで解ける
    clock.advance(16 * 60_000);
    const later = await sessionOf(db, token);
    await unlockScreen(ctx, later.session, later.user, { password: "kq7vz2mw-long1" });
    expect((await resolveSession(ctx, token)).kind).toBe("active");
  });

  it("F3：一時停止のとき、ログインし終えたセッションは使える。ログインの途中のセッションは閉じ、再認証は断る", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 2 });
    const { secret, token: active } = await enrolledUser(ctx, clock);
    const pending = await login(ctx, "tanaka", PASSWORD);
    expect(pending.stage).toBe("totp");
    // ほかの人が、この利用者名でパスワードを続けて間違える
    for (let i = 0; i < 2; i++) await login(ctx, "tanaka", "wrong-pass-123").catch(() => undefined);
    const user = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(clock.t);
    // ログインし終えたセッションは残り、使える
    expect((await resolveSession(ctx, active)).kind).toBe("active");
    // ログインの途中のセッションは閉じた
    expect(await db.session.findUnique({ where: { id: hashToken(pending.token) } })).toBeNull();
    expect((await resolveSession(ctx, pending.token)).kind).toBe("anonymous");
    // 一時停止の間は、パスワードを確かめる操作を断る（セッションは閉じない）
    const s = await sessionOf(db, active);
    await expect(
      reauthenticate(ctx, s.session, s.user, { password: PASSWORD, code: totpAt(secret, clock.t) }),
    ).rejects.toMatchObject({ status: 401, problems: ["locked"] });
    expect((await resolveSession(ctx, active)).kind).toBe("active");
    const rows = await auditRows(db);
    expect(rows.some((x) => x.action === "reauth" && x.outcome === "denied" && x.detail?.includes("locked"))).toBe(true);
  });
});

describe("セッション", () => {
  it("cookie の token そのものはデータベースに置かない", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    const rows = await db.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(hashToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(await auditRows(db))).not.toContain(token);
  });

  it("ログアウトでセッションを消し、記録に残す", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    const s = await sessionOf(db, token);
    await logout(ctx, s.session, s.user);
    expect((await resolveSession(ctx, token)).kind).toBe("anonymous");
    expect((await auditRows(db)).at(-1)).toMatchObject({ action: "logout", actorId: "sato", sourceAddressUnverified: "198.51.100.7" });
  });

  it("途中のセッションは 10 分、ログインしたセッションは 12 時間で切れる", async () => {
    const { ctx, clock } = await setup({ screenLockMinutes: 0 });
    await enrolledUser(ctx, clock);
    const pending = await login(ctx, "tanaka", PASSWORD);
    clock.advance(10 * 60_000);
    expect((await resolveSession(ctx, pending.token)).kind).toBe("anonymous");

    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const relaxed = { ...ctx, settings: { ...ctx.settings, mfaRequired: false } };
    const active = await login(relaxed, "sato", "kq7vz2mw-long1");
    expect(active.stage).toBe("active");
    clock.advance(12 * 60 * 60_000 - 1000);
    expect((await resolveSession(relaxed, active.token)).kind).toBe("active");
    clock.advance(1000);
    expect((await resolveSession(relaxed, active.token)).kind).toBe("anonymous");
  });

  it("止めた利用者のセッションは、次の要求から使えない", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    const u = await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    await createUser(ctx, { username: "admin1", displayName: "管理", role: "admin", password: "kq7vz2mw-long2", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    await updateUser(ctx, u.id, { status: "disabled" }, ADMIN);
    expect((await resolveSession(ctx, token)).kind).toBe("anonymous");
    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
  });
});

describe("管理者の操作（棚卸し・役割）", () => {
  it("役割の変更を記録に残し、次の要求から新しい役割になる", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    const u = await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    await updateUser(ctx, u.id, { role: "technologist" }, { actorId: "admin1", actorRole: "admin" });
    const resolved = await resolveSession(ctx, token);
    expect(resolved.kind === "active" && resolved.user.role).toBe("technologist");
    expect((await auditRows(db)).find((r) => r.action === "role_change")).toMatchObject({
      actorId: "admin1",
      detail: JSON.stringify({ target: "sato", from: "viewer", to: "technologist" }),
    });
  });

  it("有効な管理者が1人もいなくなる変更は断る", async () => {
    const { ctx } = await setup({ mfaRequired: false });
    const a = await createUser(ctx, { username: "admin1", displayName: "管理", role: "admin", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    await expect(updateUser(ctx, a.id, { role: "viewer" }, ADMIN)).rejects.toMatchObject({ status: 409 });
    await expect(updateUser(ctx, a.id, { status: "disabled" }, ADMIN)).rejects.toMatchObject({ status: 409 });
    await createUser(ctx, { username: "admin2", displayName: "管理2", role: "admin", password: "kq7vz2mw-long2", mustChangePassword: false }, ADMIN);
    await updateUser(ctx, a.id, { role: "viewer" }, ADMIN);
  });

  it("棚卸しの一覧に、最後のログインと TOTP の有無を出す（パスワードのハッシュ・TOTP の秘密は出さない）", async () => {
    const { ctx, clock } = await setup();
    await enrolledUser(ctx, clock);
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: PASSWORD, mustChangePassword: true }, ADMIN);
    const list = await listUsers(ctx);
    expect(list.map((u) => [u.username, u.totpEnabled, u.lastLoginAt !== null])).toEqual([
      ["sato", false, false],
      ["tanaka", true, true],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/argon2id|v1:/);
  });

  it("TOTP のやり直しで秘密を消し、次のログインで登録の段にする", async () => {
    const { ctx, db, clock } = await setup();
    const { token } = await enrolledUser(ctx, clock);
    const user = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    await updateUser(ctx, user.id, { resetTotp: true }, ADMIN);
    expect((await resolveSession(ctx, token)).kind).toBe("anonymous");
    expect((await login(ctx, "tanaka", PASSWORD)).stage).toBe("enroll");
    expect((await auditRows(db)).map((r) => r.action)).toContain("mfa_reset");
  });

  it("SESSION_SECRET を替えると TOTP の秘密は読めず、ログインは断られる（管理者がやり直す）", async () => {
    const { ctx, db, clock } = await setup();
    await enrolledUser(ctx, clock);
    const other = { ...ctx, settings: { ...ctx.settings, sessionSecret: "t".repeat(48) } };
    const r = await login(other, "tanaka", PASSWORD);
    const s = await sessionOf(db, r.token);
    await expect(submitTotp(other, s.session, s.user, "123456")).rejects.toMatchObject({ status: 409 });
  });
});

describe("最初の管理者", () => {
  const config = (initialAdmin?: { username: string; passwordFile: string }) => ({
    auth: {
      mode: "local" as const,
      mfaRequired: true,
      loginLockThreshold: 5,
      loginLockMinutes: 15,
      screenLockMinutes: 15,
      screenUnlockRequireTotp: false,
      rateLimitPerUserPerMinute: 10,
      rateLimitGlobalPerMinute: 300,
      passwordHashConcurrency: 2,
      passwordHashQueue: 32,
      pendingSessionMinutes: 10,
      sessionMaxHours: 12,
      reauthMinutes: 5,
      oidc: {},
      initialAdmin,
    },
  });

  it("利用者がいなければ、ファイルのパスワードで管理者を作る（次のログインで変える）", async () => {
    const { ctx, db } = await setup();
    const result = await bootstrapInitialAdmin(ctx, config({ username: "admin", passwordFile: "/run/secrets/admin" }), {
      readFile: () => `${PASSWORD}\n`,
    });
    expect(result).toBe("created");
    const admin = await db.user.findUniqueOrThrow({ where: { username: "admin" } });
    expect(admin).toMatchObject({ role: "admin", mustChangePassword: true, status: "active" });
    expect((await login(ctx, "admin", PASSWORD)).stage).toBe("enroll");
  });

  it("利用者が1人でもいれば何もしない（1回だけ）", async () => {
    const { ctx, db } = await setup();
    await createUser(ctx, { username: "tanaka", displayName: "田中", role: "admin", password: PASSWORD, mustChangePassword: false }, ADMIN);
    const result = await bootstrapInitialAdmin(ctx, config({ username: "admin", passwordFile: "/x" }), {
      readFile: () => NEW_PASSWORD,
    });
    expect(result).toBe("skipped");
    expect(await db.user.count()).toBe(1);
  });

  it("利用者がいず、設定も無ければ no-users（起動を止める）。規則に合わないパスワードは作らない", async () => {
    const { ctx } = await setup();
    expect(await bootstrapInitialAdmin(ctx, config())).toBe("no-users");
    const weak = bootstrapInitialAdmin(ctx, config({ username: "admin", passwordFile: "/x" }), { readFile: () => "password1" });
    await expect(weak).rejects.toBeInstanceOf(BootstrapError);
    await expect(
      bootstrapInitialAdmin(ctx, config({ username: "admin", passwordFile: "/x" }), {
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).rejects.toThrow("INITIAL_ADMIN_PASSWORD_FILE");
  });
});

describe("レビューと安全の確かめで直したこと", () => {
  it("同時に多くの TOTP を試しても、決めた回数より多くは確かめない（試みの枠を原子的に取る）", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 3 });
    await enrolledUser(ctx, clock);
    const r = await login(ctx, "tanaka", PASSWORD);
    const s = await sessionOf(db, r.token);
    const guesses = Array.from({ length: 25 }, (_, i) => String(100000 + i));
    const results = await Promise.allSettled(guesses.map((g) => submitTotp(ctx, s.session, s.user, g)));
    expect(results.every((x) => x.status === "rejected")).toBe(true);
    const rows = await auditRows(db);
    // 確かめに進んだのは決めた回数だけ。残りは一時停止として断った
    expect(rows.filter((x) => x.action === "login" && x.detail?.includes("bad_totp"))).toHaveLength(3);
    expect(rows.filter((x) => x.action === "login_lock")).toHaveLength(1);
    const user = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(clock.t);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it("同時に多くのパスワードを試しても、決めた回数より多くは確かめない", async () => {
    const { ctx, db } = await setup({ loginLockThreshold: 3, mfaRequired: false });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const tries = Array.from({ length: 12 }, (_, i) => login(ctx, "sato", `wrong-pass-${i}a`));
    await Promise.allSettled(tries);
    const rows = await auditRows(db);
    expect(rows.filter((x) => x.action === "login" && x.detail?.includes("bad_password"))).toHaveLength(3);
    await expect(login(ctx, "sato", "kq7vz2mw-long1")).rejects.toBeInstanceOf(AuthFailure);
  });

  it("同じ利用者名への試みが多いと、断らずに遅らせる（指数的に増え、上限で止まる）。知らない利用者名でも同じ", async () => {
    const { ctx, db } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 3, rateLimitGlobalPerMinute: 1000 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const known: number[] = [];
    const unknown: number[] = [];
    for (let i = 0; i < 8; i++) {
      slept = [];
      await expect(login(ctx, "nobody", "wrong-pass-1a")).rejects.toMatchObject({ status: 401 });
      unknown.push(slept[0] ?? 0);
    }
    const relaxed = { ...ctx, settings: { ...ctx.settings, loginLockThreshold: 100 } };
    for (let i = 0; i < 8; i++) {
      slept = [];
      await expect(login(relaxed, "sato", "wrong-pass-1a")).rejects.toMatchObject({ status: 401 });
      known.push(slept[0] ?? 0);
    }
    expect(unknown).toEqual([0, 0, 0, 250, 500, 1000, 2000, 4000]);
    expect(known).toEqual(unknown);
    // 遅らせても、正しいパスワードなら通る（締め出さない）
    expect((await login(relaxed, "sato", "kq7vz2mw-long1")).stage).toBe("active");
    for (let i = 0; i < 10; i++) await login(ctx, "nobody", "x").catch(() => undefined);
    expect(Math.max(...slept)).toBe(MAX_DELAY_MS);
    // 遅らせ始めたことは、枠ごとに1回だけ記録に残す（利用者名は残さない）
    const rows = await auditRows(db);
    expect(rows.filter((r) => r.detail?.includes("throttled"))).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain("nobody");
  });

  it("ほかの利用者名への失敗では、正しい利用者は遅れない。偽れる接続元（X-Forwarded-For）を変えても鍵は分かれない", async () => {
    const { ctx } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 2, rateLimitGlobalPerMinute: 1000 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const spoofed = (i: number) => ({ ...ctx, source: { sourceAddress: null, sourceAddressUnverified: `198.51.100.${i}` } });
    for (let i = 0; i < 6; i++) await login(spoofed(i), "victim-other", "wrong-pass-1a").catch(() => undefined);
    expect(slept.length).toBeGreaterThan(0);
    slept = [];
    expect((await login(ctx, "sato", "kq7vz2mw-long1")).stage).toBe("active");
    expect(slept).toEqual([]);
  });

  it("全体の試みが多いと、全員を遅らせる（締め出さない）。1 分たてば戻る", async () => {
    const { ctx, clock } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 1000, rateLimitGlobalPerMinute: 4 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    for (let i = 0; i < 4; i++) await login(ctx, `attacker${i}`, "wrong-pass-1a").catch(() => undefined);
    slept = [];
    expect((await login(ctx, "sato", "kq7vz2mw-long1")).stage).toBe("active");
    expect(slept).toEqual([250]);
    clock.advance(60_000);
    slept = [];
    await login(ctx, "sato", "kq7vz2mw-long1");
    expect(slept).toEqual([]);
  });

  it("ログインの試みが多くても、ロックの解除と再認証は遅らせない", async () => {
    const { ctx, db, clock } = await setup({ rateLimitPerUserPerMinute: 1, rateLimitGlobalPerMinute: 1 });
    const { secret, token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    for (let i = 0; i < 5; i++) await login(ctx, "nobody", "wrong-pass-1a").catch(() => undefined);
    slept = [];
    const locked = await sessionOf(db, token);
    await unlockScreen(ctx, locked.session, locked.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    clock.advance(30_000);
    const active = await sessionOf(db, token);
    await reauthenticate(ctx, active.session, active.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    expect(slept).toEqual([]);
  });

  it("利用者名の書き方を変えても同じ鍵で数える（大文字小文字・前後と途中の空白・全角半角）", async () => {
    const { ctx } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 2, rateLimitGlobalPerMinute: 1000, loginLockThreshold: 100 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    expect(normalizeUsername(" Ｓａｔｏ ")).toBe("sato");
    expect(normalizeUsername("S a\u3000to")).toBe("sato");
    const delays: number[] = [];
    for (const name of ["sato", "SATO", " sato ", "Ｓａｔｏ", "s\u3000ato", "SaTo"]) {
      slept = [];
      await login(ctx, name, "wrong-pass-1a").catch(() => undefined);
      delays.push(slept[0] ?? 0);
    }
    expect(delays).toEqual([0, 0, 250, 500, 1000, 2000]);
    // 正規化した名前でログインできる（同じ利用者）
    expect((await login(ctx, " ＳＡＴＯ ", "kq7vz2mw-long1")).stage).toBe("active");
  });

  it("存在しない利用者名を次々に替えても、全体の数で遅らせる（すり抜けない）。記憶は桶の数を超えない", async () => {
    const { ctx } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 2, rateLimitGlobalPerMinute: 5 });
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      slept = [];
      await login(ctx, `ghost-${i}`, "wrong-pass-1a").catch(() => undefined);
      delays.push(slept[0] ?? 0);
    }
    expect(delays).toEqual([0, 0, 0, 0, 0, 250, 500, 1000, 2000]);

    const throttle = new LoginThrottle();
    const settings = { perKeyPerMinute: 5, globalPerMinute: 1_000_000 };
    const t = 1_800_000_000_000;
    for (let i = 0; i < BUCKETS * 5; i++) throttle.take(`ghost-${i}`, null, settings, t);
    expect(throttle.usedBuckets).toBeLessThanOrEqual(BUCKETS);
    // 次の枠では数を0に戻す
    throttle.take("someone", null, settings, t + 60_000);
    expect(throttle.usedBuckets).toBe(1);
  });

  it("存在する利用者名と存在しない利用者名は、同じに遅らせる（遅れ方で有無を知られない）", async () => {
    const { ctx } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 1, rateLimitGlobalPerMinute: 1000, loginLockThreshold: 100 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    // 攻撃者がいくつもの存在しない名前を試していても、新しく試す名前の遅れ方は、存在の有無で変わらない
    for (let i = 0; i < 20; i++) await login(ctx, `ghost-${i}`, "wrong-pass-1a").catch(() => undefined);
    slept = [];
    await login(ctx, "sato", "wrong-pass-1a").catch(() => undefined);
    const known = slept[0] ?? 0;
    slept = [];
    await login(ctx, "nobody-new", "wrong-pass-1a").catch(() => undefined);
    expect(slept[0] ?? 0).toBe(known);
  });

  it("利用者の管理の前に再認証が要る。パスワードと TOTP で通り、5 分で切れる", async () => {
    const { ctx, db, clock } = await setup();
    const { secret, token } = await enrolledUser(ctx, clock, "admin1", "admin");
    const s = await sessionOf(db, token);
    expect(() => assertRecentReauth(ctx, s.session, s.user)).toThrow(AuthFailure);
    await expect(reauthenticate(ctx, s.session, s.user, { password: PASSWORD })).rejects.toMatchObject({ status: 401 });
    await expect(
      reauthenticate(ctx, s.session, s.user, { password: "wrong-pass-123", code: totpAt(secret, clock.t) }),
    ).rejects.toMatchObject({ status: 401 });
    await reauthenticate(ctx, s.session, s.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    const after = await sessionOf(db, token);
    expect(() => assertRecentReauth(ctx, after.session, after.user)).not.toThrow();
    clock.advance(REAUTH_MINUTES * 60_000);
    try {
      assertRecentReauth(ctx, after.session, after.user);
      throw new Error("通ってしまった");
    } catch (error) {
      expect(error).toMatchObject({ status: 403, problems: [REAUTH_REQUIRED] });
    }
    const actions = (await auditRows(db)).map((r) => `${r.action}:${r.outcome}`);
    expect(actions.filter((a) => a === "reauth:denied")).toHaveLength(2);
    expect(actions).toContain("reauth:success");
    expect(JSON.stringify(await auditRows(db))).not.toContain(PASSWORD);
  });

  it("ログインした後のパスワードの変更は、いまのパスワードと TOTP を求める", async () => {
    const { ctx, db, clock } = await setup();
    const { secret, token } = await enrolledUser(ctx, clock);
    const s = await sessionOf(db, token);
    await expect(changePassword(ctx, s.session, s.user, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).rejects.toMatchObject({
      status: 401,
    });
    const ok = await changePassword(ctx, s.session, s.user, {
      currentPassword: PASSWORD,
      code: totpAt(secret, clock.t),
      newPassword: NEW_PASSWORD,
    });
    expect(ok.stage).toBe("active");
    expect((await login(ctx, "tanaka", NEW_PASSWORD)).stage).toBe("totp");
  });

  it("二要素が任意のとき、ログインした後の TOTP の登録は、いまのパスワードを求める", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    const s = await sessionOf(db, token);
    const { secret } = await startEnrollment(ctx, s.session, s.user);
    const s2 = await sessionOf(db, token);
    await expect(confirmEnrollment(ctx, s2.session, s2.user, totpAt(secret, clock.t))).rejects.toMatchObject({ status: 401 });
    await expect(confirmEnrollment(ctx, s2.session, s2.user, totpAt(secret, clock.t), "wrong-pass-123")).rejects.toMatchObject({
      status: 401,
    });
    const done = await confirmEnrollment(ctx, s2.session, s2.user, totpAt(secret, clock.t), "kq7vz2mw-long1");
    expect(done.stage).toBe("active");
    expect((await db.user.findUniqueOrThrow({ where: { username: "sato" } })).totpSecretEnc).not.toBeNull();
  });

  it("TOTP を登録した利用者でも、いまの規則に合わなくなったパスワードは変える段に進む", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: true });
    const { secret } = await enrolledUser(ctx, clock, "tanaka");
    // PASSWORD は 13 文字（kq7vz2mw-pass）。8 文字の利用者を作り、MFA_REQUIRED=false にする
    const short = "kq7vz2mx";
    const u = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    await db.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(short) } });
    const relaxed = { ...ctx, settings: { ...ctx.settings, mfaRequired: false } };
    const r = await login(relaxed, "tanaka", short);
    expect(r.stage).toBe("totp");
    const s = await sessionOf(db, r.token);
    expect((await submitTotp(relaxed, s.session, s.user, totpAt(secret, clock.t))).stage).toBe("change_password");
  });

  it("2人の管理者が同時に互いを外しても、有効な管理者は0人にならない", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    const a = await createUser(ctx, { username: "admin1", displayName: "管理1", role: "admin", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const b = await createUser(ctx, { username: "admin2", displayName: "管理2", role: "admin", password: "kq7vz2mw-long2", mustChangePassword: false }, ADMIN);
    await Promise.allSettled([
      updateUser(ctx, a.id, { role: "viewer" }, ADMIN),
      updateUser(ctx, b.id, { status: "disabled" }, ADMIN),
    ]);
    expect(await db.user.count({ where: { role: "admin", status: "active" } })).toBeGreaterThanOrEqual(1);
  });
});

/** ログインの枠の確かめが終わったところで1回止める（ほかの操作を割り込ませる試験のため） */
class PausingLimiter extends HashLimiter {
  private hold?: { reached: () => void; release: Promise<void> };

  pauseNextLogin() {
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => {
      reached = r;
    });
    const releaseP = new Promise<void>((r) => {
      release = r;
    });
    this.hold = { reached, release: releaseP };
    return { reached: reachedP, release };
  }

  override async run<T>(lane: HashLane, fn: () => Promise<T>): Promise<T> {
    const value = await super.run(lane, fn);
    const hold = this.hold;
    if (lane === "login" && hold) {
      this.hold = undefined;
      hold.reached();
      await hold.release;
    }
    return value;
  }
}

/** セッションの削除（deleteMany）だけが失敗するデータベース。ほかの操作は本物に渡す */
function sessionDeleteFails(db: Db): Db {
  const bindAll = <T extends object>(target: T, override: (key: PropertyKey) => unknown) =>
    new Proxy(target, {
      get(t, key) {
        const replaced = override(key);
        if (replaced !== undefined) return replaced;
        const value = Reflect.get(t, key, t) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(t) : value;
      },
    });
  const session = bindAll(db.session, (key) =>
    key === "deleteMany" ? () => Promise.reject(new Error("セッションを消せない")) : undefined,
  );
  return bindAll(db, (key) => (key === "session" ? session : undefined));
}

const SATO = { username: "sato", displayName: "佐藤", role: "viewer" as const, password: "kq7vz2mw-long1", mustChangePassword: false };

describe("独立のレビューの指摘で直したこと", () => {
  it("F1：登録の途中のセッションを2つ開いても、2つ目の確定は断る（登録済みの TOTP を上書きしない）。登録したら、ほかのセッションを閉じる", async () => {
    const { ctx, db, clock } = await setup();
    await createUser(ctx, { ...SATO, password: PASSWORD }, ADMIN);
    const a = await login(ctx, "sato", PASSWORD);
    const b = await login(ctx, "sato", PASSWORD);
    expect([a.stage, b.stage]).toEqual(["enroll", "enroll"]);
    const sa = await sessionOf(db, a.token);
    const ea = await startEnrollment(ctx, sa.session, sa.user);
    const sb = await sessionOf(db, b.token);
    const eb = await startEnrollment(ctx, sb.session, sb.user);
    const sa2 = await sessionOf(db, a.token);
    const sb2 = await sessionOf(db, b.token);

    const done = await confirmEnrollment(ctx, sa2.session, sa2.user, totpAt(ea.secret, clock.t));
    expect(done.stage).toBe("active");
    // 2つ目の途中のセッションは閉じた
    expect(await db.session.findUnique({ where: { id: hashToken(b.token) } })).toBeNull();
    // 先に読んでおいた2つ目のセッションから確定しても、断る（登録した秘密を替えない）
    const before = (await db.user.findUniqueOrThrow({ where: { username: "sato" } })).totpSecretEnc;
    await expect(confirmEnrollment(ctx, sb2.session, sb2.user, totpAt(eb.secret, clock.t))).rejects.toMatchObject({ status: 409 });
    expect((await db.user.findUniqueOrThrow({ where: { username: "sato" } })).totpSecretEnc).toBe(before);
    const actions = (await auditRows(db)).map((r) => `${r.action}:${r.outcome}`);
    expect(actions.filter((x) => x === "mfa_enroll:success")).toHaveLength(1);
    expect(actions).toContain("mfa_enroll:denied");

    // 次のログインで要るのは、1つ目の秘密
    clock.advance(30_000);
    const r = await login(ctx, "sato", PASSWORD);
    const s = await sessionOf(db, r.token);
    expect((await submitTotp(ctx, s.session, s.user, totpAt(ea.secret, clock.t))).stage).toBe("active");
  });

  it("F1：同時に2つの登録を確定しても、通るのは1つだけ", async () => {
    const { ctx, db, clock } = await setup();
    await createUser(ctx, { ...SATO, password: PASSWORD }, ADMIN);
    const tokens = [(await login(ctx, "sato", PASSWORD)).token, (await login(ctx, "sato", PASSWORD)).token];
    const pending = [];
    for (const token of tokens) {
      const s = await sessionOf(db, token);
      const { secret } = await startEnrollment(ctx, s.session, s.user);
      pending.push({ ...(await sessionOf(db, token)), secret });
    }
    const results = await Promise.allSettled(
      pending.map((p) => confirmEnrollment(ctx, p.session, p.user, totpAt(p.secret, clock.t))),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.session.count({ where: { stage: "active" } })).toBe(1);
  });

  it("F1：二要素が任意のときのログインした後の登録も、もう登録してあれば断る", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false });
    await createUser(ctx, SATO, ADMIN);
    const tokens = [(await login(ctx, "sato", SATO.password)).token, (await login(ctx, "sato", SATO.password)).token];
    const pending = [];
    for (const token of tokens) {
      const s = await sessionOf(db, token);
      const { secret } = await startEnrollment(ctx, s.session, s.user);
      pending.push({ ...(await sessionOf(db, token)), secret });
    }
    const [first, second] = pending as [(typeof pending)[0], (typeof pending)[0]];
    expect((await confirmEnrollment(ctx, first.session, first.user, totpAt(first.secret, clock.t), SATO.password)).stage).toBe("active");
    expect(await db.session.findUnique({ where: { id: second.session.id } })).toBeNull();
    await expect(
      confirmEnrollment(ctx, second.session, second.user, totpAt(second.secret, clock.t), SATO.password),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("F4：ログインの途中のセッションが、もう使われていたら、新しいセッションを作らない（同じ途中のセッションから二度ログインさせない）", async () => {
    const { ctx, db, clock } = await setup();
    const { secret } = await enrolledUser(ctx, clock);
    const r = await login(ctx, "tanaka", PASSWORD);
    const stale = await sessionOf(db, r.token);
    // 前後の段の番号はどちらも受ける窓に入る（使い回しの確かめは段ごとなので、別の段なら通る）
    expect((await submitTotp(ctx, stale.session, stale.user, totpAt(secret, clock.t))).stage).toBe("active");
    const activeBefore = await db.session.count({ where: { userId: stale.user.id, stage: "active" } });
    await expect(submitTotp(ctx, stale.session, stale.user, totpAt(secret, clock.t + 30_000))).rejects.toMatchObject({
      status: 409,
      message: SESSION_GONE_MESSAGE,
    });
    expect(await db.session.count({ where: { userId: stale.user.id, stage: "active" } })).toBe(activeBefore);
  });

  it("F4：確かめている間に、利用者を止めた・TOTP の秘密が替わったら、ログインしたセッションを作らない", async () => {
    const { ctx, db, clock } = await setup();
    const { secret } = await enrolledUser(ctx, clock);
    const user = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    const countActive = () => db.session.count({ where: { userId: user.id, stage: "active" } });

    const r1 = await login(ctx, "tanaka", PASSWORD);
    const s1 = await sessionOf(db, r1.token);
    const activeBefore = await countActive();
    // 止めた（セッションを消す前の、確かめとの間）
    await db.user.update({ where: { id: user.id }, data: { status: "disabled" } });
    await expect(submitTotp(ctx, s1.session, s1.user, totpAt(secret, clock.t))).rejects.toMatchObject({ status: 401 });
    expect(await countActive()).toBe(activeBefore);
    await db.user.update({ where: { id: user.id }, data: { status: "active" } });

    clock.advance(30_000);
    const r2 = await login(ctx, "tanaka", PASSWORD);
    const s2 = await sessionOf(db, r2.token);
    // TOTP の秘密の行が替わった（やり直して登録し直した、の間。暗号化し直すと値は毎回違う）
    await db.user.update({ where: { id: user.id }, data: { totpSecretEnc: sealField(secret, SESSION_SECRET, user.id) } });
    await expect(submitTotp(ctx, s2.session, s2.user, totpAt(secret, clock.t))).rejects.toMatchObject({ status: 401 });
    expect(await countActive()).toBe(activeBefore);
    const reasons = (await auditRows(db)).map((x) => x.detail ?? "");
    expect(reasons.filter((d) => d.includes("changed_during_login"))).toHaveLength(2);
  });

  it("F5：パスワードの変更と同時に進んでいた、古いパスワードのログインは、セッションを作らない", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false });
    const limiter = new PausingLimiter({ concurrency: 2, queueLimit: 10 });
    ctx.hashLimiter = limiter;
    await createUser(ctx, SATO, ADMIN);
    const mine = await login(ctx, "sato", SATO.password);

    const pause = limiter.pauseNextLogin();
    const racing = login(ctx, "sato", SATO.password);
    // 古いパスワードの確かめが通ったところで、ほかの画面からパスワードを変える
    await pause.reached;
    clock.advance(1000);
    const s = await sessionOf(db, mine.token);
    await changePassword(ctx, s.session, s.user, { currentPassword: SATO.password, newPassword: "zr4tx8pe-next-long" });
    pause.release();

    await expect(racing).rejects.toMatchObject({ status: 401 });
    const sessions = await db.session.findMany({ where: { userId: s.user.id } });
    expect(sessions.map((x) => x.id)).toEqual([hashToken(mine.token)]);
    expect((await auditRows(db)).some((x) => x.detail?.includes("changed_during_login"))).toBe(true);
    // 新しいパスワードでは入れる
    expect((await login(ctx, "sato", "zr4tx8pe-next-long")).stage).toBe("active");
  });

  it("F2：パスワードの確かめの枠と待ちが埋まっていたら、待たせずに 503（Retry-After）。試みの枠は使わない。ログインした人の再認証は通る", async () => {
    const { ctx, db, clock } = await setup({ passwordHashConcurrency: 1, passwordHashQueue: 0, rateLimitPerUserPerMinute: 1 });
    const { secret, token } = await enrolledUser(ctx, clock);
    let release!: () => void;
    const held = ctx.hashLimiter!.run("login", () => new Promise<void>((r) => (release = r)));

    slept = [];
    for (let i = 0; i < 3; i++) {
      const error = await login(ctx, "tanaka", PASSWORD).catch((e: unknown) => e);
      expect(error).toMatchObject({ status: 503, message: HASH_BUSY_MESSAGE, retryAfterSeconds: HASH_BUSY_RETRY_AFTER_SECONDS });
    }
    // 遅らせの上限を超えていても、断る要求は待たせない
    expect(slept).toEqual([]);
    expect((await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).failedLoginCount).toBe(0);
    // ログインした人（再認証・ロックの解除）は、取っておいた枠で通る
    const s = await sessionOf(db, token);
    await reauthenticate(ctx, s.session, s.user, { password: PASSWORD, code: totpAt(secret, clock.t) });

    release();
    await held;
    expect((await login(ctx, "tanaka", PASSWORD)).stage).toBe("totp");
    // 断った要求は、1行ずつではなく、まとめて残す
    expect(await flushFailureDigest(ctx, true)).toBe(1);
    const busy = (await auditRows(db)).filter((x) => x.detail?.includes('"busy"'));
    expect(busy).toHaveLength(1);
    expect(JSON.parse(busy[0]!.detail!)).toMatchObject({ reason: "busy", aggregated: 3 });
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it("F2：遅らせている間に枠が埋まったら、確かめの前に 503。取った試みの枠は返す", async () => {
    const { ctx, db } = await setup({ mfaRequired: false, passwordHashConcurrency: 1, passwordHashQueue: 0, rateLimitPerUserPerMinute: 1 });
    await createUser(ctx, SATO, ADMIN);
    await login(ctx, "sato", SATO.password);
    let release: (() => void) | undefined;
    let held: Promise<void> | undefined;
    ctx.sleep = async () => {
      held = ctx.hashLimiter!.run("login", () => new Promise<void>((r) => (release = r)));
    };
    await expect(login(ctx, "sato", "wrong-pass-1a")).rejects.toMatchObject({ status: 503 });
    expect((await db.user.findUniqueOrThrow({ where: { username: "sato" } })).failedLoginCount).toBe(0);
    release!();
    await held;
  });

  it("F2：遅らせの上限を超えた試みの失敗は、1 分の枠ごとに「利用者×理由」の1行にまとめる（上限の中は1行ずつ）", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 2, loginLockThreshold: 100 });
    await createUser(ctx, SATO, ADMIN);
    for (let i = 0; i < 6; i++) await login(ctx, "nobody", "wrong-pass-1a").catch(() => undefined);
    for (let i = 0; i < 6; i++) await login(ctx, "sato", "wrong-pass-1a").catch(() => undefined);
    let rows = await auditRows(db);
    expect(rows.filter((x) => x.detail?.includes("unknown_user"))).toHaveLength(2);
    expect(rows.filter((x) => x.detail?.includes("bad_password"))).toHaveLength(2);

    // 枠が替わった後の最初のログインの要求で、まとめた行を書く
    clock.advance(60_000);
    expect((await login(ctx, "sato", SATO.password)).stage).toBe("active");
    rows = await auditRows(db);
    const aggregated = rows
      .filter((x) => x.detail?.includes("aggregated"))
      .map((x) => ({ actorId: x.actorId, ...(JSON.parse(x.detail!) as Record<string, unknown>) }));
    expect(aggregated).toHaveLength(2);
    expect(aggregated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: "unknown", reason: "unknown_user", aggregated: 4 }),
        expect.objectContaining({ actorId: "sato", reason: "bad_password", aggregated: 4 }),
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain("nobody");
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it("F2：名前を次々に替えて全体の上限を超えても、行は名前の数だけ増えない（遅らせ始めた印もまとめる）", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false, rateLimitPerUserPerMinute: 1, rateLimitGlobalPerMinute: 5 });
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 2; j++) await login(ctx, `ghost-${i}`, "wrong-pass-1a").catch(() => undefined);
    }
    let rows = await auditRows(db);
    // 全体の上限の中の失敗（3 回）と、遅らせ始めた印（上限の中の2つと、全体で超えた1つ）だけが1行ずつ
    expect(rows.filter((x) => x.detail?.includes("unknown_user"))).toHaveLength(3);
    expect(rows.filter((x) => x.detail?.includes("throttled"))).toHaveLength(3);
    clock.advance(60_000);
    expect(await flushFailureDigest(ctx)).toBe(2);
    rows = await auditRows(db);
    const aggregated = rows.filter((x) => x.detail?.includes("aggregated")).map((x) => JSON.parse(x.detail!) as Record<string, unknown>);
    expect(aggregated).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "unknown_user", aggregated: 77 }),
        expect.objectContaining({ reason: "throttled" }),
      ]),
    );
    // 桶が重なった名前は、1回目から遅らせるので印が出ない（37 より少しだけ少ないことがある）
    const throttledMarks = aggregated.find((x) => x.reason === "throttled")!.aggregated as number;
    expect(throttledMarks).toBeGreaterThan(30);
    expect(throttledMarks).toBeLessThanOrEqual(37);
    expect(rows.length).toBeLessThan(10);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it("F2：まとめた失敗を書けなかったら戻し、次に書き直す", async () => {
    const { ctx, db, clock } = await setup();
    ctx.failureDigest!.add({ actorId: "unknown", actorRole: "none" }, "unknown_user", clock.now());
    clock.advance(60_000);
    const broken = { ...ctx, db: { $transaction: () => Promise.reject(new Error("書けない")) } as unknown as Db };
    await expect(flushFailureDigest(broken)).rejects.toThrow("書けない");
    expect(ctx.failureDigest!.size).toBe(1);
    expect(await flushFailureDigest(ctx)).toBe(1);
    expect((await auditRows(db)).filter((x) => x.detail?.includes("aggregated"))).toHaveLength(1);
  });

  it("F1（Codex の指摘）：読んだ後に消えた登録の途中のセッションからは、TOTP を書かない", async () => {
    const { ctx, db, clock } = await setup();
    await createUser(ctx, { ...SATO, password: PASSWORD }, ADMIN);
    const r = await login(ctx, "sato", PASSWORD);
    const s = await sessionOf(db, r.token);
    const { secret } = await startEnrollment(ctx, s.session, s.user);
    const stale = await sessionOf(db, r.token);
    await logout(ctx, stale.session, stale.user);
    await expect(confirmEnrollment(ctx, stale.session, stale.user, totpAt(secret, clock.t))).rejects.toMatchObject({
      status: 409,
      message: SESSION_GONE_MESSAGE,
    });
    expect((await db.user.findUniqueOrThrow({ where: { username: "sato" } })).totpSecretEnc).toBeNull();
  });

  it("F5（Codex の指摘）：読んだ後に消えた途中のセッションでは、パスワードを変えない", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    await createUser(ctx, { ...SATO, mustChangePassword: true }, ADMIN);
    const r = await login(ctx, "sato", SATO.password);
    expect(r.stage).toBe("change_password");
    const stale = await sessionOf(db, r.token);
    await logout(ctx, stale.session, stale.user);
    await expect(changePassword(ctx, stale.session, stale.user, { newPassword: "zr4tx8pe-next-long" })).rejects.toMatchObject({
      status: 409,
    });
    const after = await db.user.findUniqueOrThrow({ where: { username: "sato" } });
    expect(after.passwordHash).toBe(stale.user.passwordHash);
  });

  it("F5（Codex の指摘）：ログインしたセッションで、読んだ後に TOTP の秘密が替わったら、パスワードを変えない", async () => {
    const { ctx, db, clock } = await setup();
    const { secret, token } = await enrolledUser(ctx, clock, "tanaka");
    const s = await sessionOf(db, token);
    await db.user.update({ where: { id: s.user.id }, data: { totpSecretEnc: sealField(secret, SESSION_SECRET, s.user.id) } });
    await expect(
      changePassword(ctx, s.session, s.user, { currentPassword: PASSWORD, code: totpAt(secret, clock.t), newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await db.user.findUniqueOrThrow({ where: { id: s.user.id } })).passwordHash).toBe(s.user.passwordHash);
  });

  it("認証の世代：パスワードの変更の後、ほかのセッションの削除が失敗しても、古いセッションは使えない", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    await createUser(ctx, SATO, ADMIN);
    const mine = await login(ctx, "sato", SATO.password);
    const other = await login(ctx, "sato", SATO.password);
    const s = await sessionOf(db, mine.token);
    // セッションの削除だけが失敗するデータベース（変更の途中で止まった、の代わり）
    const flaky = sessionDeleteFails(db);
    await changePassword({ ...ctx, db: flaky }, s.session, s.user, { currentPassword: SATO.password, newPassword: "zr4tx8pe-next-long" });
    // 古いセッションの行は残っているが、使えない
    expect(await db.session.findUnique({ where: { id: hashToken(other.token) } })).not.toBeNull();
    expect((await resolveSession(ctx, other.token)).kind).toBe("anonymous");
    // 変えた人のセッションは新しい世代に合わせてあり、使える
    expect((await resolveSession(ctx, mine.token)).kind).toBe("active");
    const after = await db.user.findUniqueOrThrow({ where: { username: "sato" } });
    expect(after.credentialVersion).toBe(s.user.credentialVersion + 1);
  });

  it("認証の世代：TOTP の登録・やり直しの後も、削除が失敗した古いセッションは使えない", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false });
    const u = await createUser(ctx, SATO, ADMIN);
    const mine = await login(ctx, "sato", SATO.password);
    const other = await login(ctx, "sato", SATO.password);
    const s = await sessionOf(db, mine.token);
    const { secret } = await startEnrollment(ctx, s.session, s.user);
    const s2 = await sessionOf(db, mine.token);
    const flaky = sessionDeleteFails(db);
    await confirmEnrollment({ ...ctx, db: flaky }, s2.session, s2.user, totpAt(secret, clock.t), SATO.password);
    expect((await resolveSession(ctx, other.token)).kind).toBe("anonymous");
    expect((await resolveSession(ctx, mine.token)).kind).toBe("active");

    // 管理者が TOTP をやり直す（削除が失敗しても、その利用者のセッションは使えない）
    await updateUser({ ...ctx, db: flaky }, u.id, { resetTotp: true }, ADMIN);
    expect((await resolveSession(ctx, mine.token)).kind).toBe("anonymous");
  });

  it("認証の世代：登録の段で TOTP を登録して、パスワードの変更の段に進んでも、同じ途中のセッションを使える", async () => {
    const { ctx, db, clock } = await setup();
    await createUser(ctx, { ...SATO, password: PASSWORD, mustChangePassword: true }, ADMIN);
    const r = await login(ctx, "sato", PASSWORD);
    const s = await sessionOf(db, r.token);
    const { secret } = await startEnrollment(ctx, s.session, s.user);
    const s2 = await sessionOf(db, r.token);
    expect((await confirmEnrollment(ctx, s2.session, s2.user, totpAt(secret, clock.t))).stage).toBe("change_password");
    const resolved = await resolveSession(ctx, r.token);
    expect(resolved).toMatchObject({ kind: "pending", session: { stage: "change_password" } });
    const s3 = await sessionOf(db, r.token);
    const done = await changePassword(ctx, s3.session, s3.user, { newPassword: NEW_PASSWORD });
    expect(done.stage).toBe("active");
    expect((await resolveSession(ctx, done.rotated!.token)).kind).toBe("active");
  });

  it("セッションの長さと再認証の時間は設定で変えられる", async () => {
    const { ctx, db, clock } = await setup({ pendingSessionMinutes: 3, sessionMaxHours: 1, reauthMinutes: 2 });
    const { secret, token } = await enrolledUser(ctx, clock, "admin1", "admin");
    const active = await sessionOf(db, token);
    expect(active.session.expiresAt.getTime() - active.session.createdAt.getTime()).toBe(60 * 60_000);
    const pending = await login(ctx, "admin1", PASSWORD);
    expect(pending.expiresAt.getTime() - clock.t).toBe(3 * 60_000);
    await reauthenticate(ctx, active.session, active.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    const after = await sessionOf(db, token);
    clock.advance(2 * 60_000 - 1000);
    expect(() => assertRecentReauth(ctx, after.session, after.user)).not.toThrow();
    clock.advance(1000);
    expect(() => assertRecentReauth(ctx, after.session, after.user)).toThrow(AuthFailure);
  });

  it("認証の世代：確かめた後に世代が上がったら、作ったセッションは使えない", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    const limiter = new PausingLimiter({ concurrency: 2, queueLimit: 10 });
    ctx.hashLimiter = limiter;
    const u = await createUser(ctx, SATO, ADMIN);
    const pause = limiter.pauseNextLogin();
    const racing = login(ctx, "sato", SATO.password);
    await pause.reached;
    await db.user.update({ where: { id: u.id }, data: { credentialVersion: { increment: 1 } } });
    pause.release();
    await expect(racing).rejects.toMatchObject({ status: 401 });
    expect(await db.session.count({ where: { userId: u.id } })).toBe(0);
  });

  it("総当たり：5つの道（ログイン・TOTP・ロックの解除・再認証・パスワードの変更）の失敗は同じ一時停止に数え、一時停止の間はどの道も確かめない", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 5 });
    const { secret, token: a } = await enrolledUser(ctx, clock);
    // もう1つ、ログインし終えたセッションを作る（一時停止の後も閉じない。F3）
    const rb = await login(ctx, "tanaka", PASSWORD);
    const sb0 = await sessionOf(db, rb.token);
    const b = (await submitTotp(ctx, sb0.session, sb0.user, totpAt(secret, clock.t))).rotated!.token;
    clock.advance(30_000);
    const count = async () => (await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).failedLoginCount;
    expect(await count()).toBe(0);

    // ① ログインのパスワード
    await expect(login(ctx, "tanaka", "wrong-pass-123")).rejects.toMatchObject({ status: 401 });
    expect(await count()).toBe(1);
    // ② TOTP の6桁（パスワードが合っても、番号の失敗は数える）
    const rt = await login(ctx, "tanaka", PASSWORD);
    const st = await sessionOf(db, rt.token);
    await expect(submitTotp(ctx, st.session, st.user, "000000")).rejects.toMatchObject({ status: 401 });
    expect(await count()).toBe(2);
    // ③ 画面のロックの解除
    const sa = await sessionOf(db, a);
    await lockScreen(ctx, sa.session, sa.user, "manual");
    const la = await sessionOf(db, a);
    await expect(unlockScreen(ctx, la.session, la.user, { password: "wrong-pass-123" })).rejects.toMatchObject({ status: 401 });
    expect(await count()).toBe(3);
    // ④ 再認証
    const sb = await sessionOf(db, b);
    await expect(reauthenticate(ctx, sb.session, sb.user, { password: "wrong-pass-123" })).rejects.toMatchObject({ status: 401 });
    expect(await count()).toBe(4);
    // ⑤ パスワードの変更のときの、いまのパスワード（5回目で一時停止）
    await expect(
      changePassword(ctx, sb.session, sb.user, { currentPassword: "wrong-pass-123", code: totpAt(secret, clock.t), newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ status: 401, problems: ["locked"] });
    const locked = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(clock.t);

    // 一時停止の間は、正しいパスワードと番号でも、どの道も確かめない
    clock.advance(30_000);
    await expect(login(ctx, "tanaka", PASSWORD)).rejects.toMatchObject({ status: 401 });
    const la2 = await sessionOf(db, a);
    await expect(unlockScreen(ctx, la2.session, la2.user, { password: PASSWORD, code: totpAt(secret, clock.t) })).rejects.toMatchObject({
      problems: ["locked"],
    });
    const sb2 = await sessionOf(db, b);
    await expect(reauthenticate(ctx, sb2.session, sb2.user, { password: PASSWORD, code: totpAt(secret, clock.t) })).rejects.toMatchObject({
      problems: ["locked"],
    });
    await expect(
      changePassword(ctx, sb2.session, sb2.user, { currentPassword: PASSWORD, code: totpAt(secret, clock.t), newPassword: NEW_PASSWORD }),
    ).rejects.toMatchObject({ problems: ["locked"] });
    // 止めている間の試みは数えず、一時停止の記録は1行
    const rows = await auditRows(db);
    expect(rows.filter((x) => x.action === "login_lock")).toHaveLength(1);
    expect((await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).passwordHash).toBe(locked.passwordHash);
    // ログインし終えたセッションは閉じない（F3）
    expect((await resolveSession(ctx, a)).kind).toBe("locked");
    expect((await resolveSession(ctx, b)).kind).toBe("active");
  });

  it("総当たり：混んで断る（503）答えは、パスワードが合っても違っても同じで、確かめずに数えない（503 を繰り返させても試せない）", async () => {
    const { ctx, db, clock } = await setup({ passwordHashConcurrency: 1, passwordHashQueue: 0 });
    const { secret, token } = await enrolledUser(ctx, clock);
    const releases: (() => void)[] = [];
    const hold = (lane: HashLane) =>
      ctx.hashLimiter!.run(lane, () => new Promise<void>((r) => releases.push(r)));
    // ログインの枠と、ログインした人の取っておいた1本の両方を埋める
    const held = [hold("login"), hold("priority")];
    await new Promise((r) => setTimeout(r, 0));

    const shape = (e: unknown) => {
      const f = e as AuthFailure;
      return { status: f.status, message: f.message, problems: f.problems, retry: f.retryAfterSeconds };
    };
    const right = await login(ctx, "tanaka", PASSWORD).catch(shape);
    const wrong = await login(ctx, "tanaka", "wrong-pass-123").catch(shape);
    expect(right).toEqual(wrong);
    expect(right).toMatchObject({ status: 503 });
    const s = await sessionOf(db, token);
    const reRight = await reauthenticate(ctx, s.session, s.user, { password: PASSWORD, code: totpAt(secret, clock.t) }).catch(shape);
    const reWrong = await reauthenticate(ctx, s.session, s.user, { password: "wrong-pass-123" }).catch(shape);
    expect(reRight).toEqual(reWrong);
    expect(reRight).toMatchObject({ status: 503 });
    for (let i = 0; i < 20; i++) await login(ctx, "tanaka", `wrong-pass-${i}a`).catch(() => undefined);
    // 1つも確かめていないので、数えず、一時停止にもならない
    const user = await db.user.findUniqueOrThrow({ where: { username: "tanaka" } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect((await auditRows(db)).filter((x) => x.detail?.includes("bad_password"))).toHaveLength(0);

    for (const r of releases) r();
    await Promise.all(held);
    // 空いたら、ふつうに確かめて数える
    await expect(login(ctx, "tanaka", "wrong-pass-123")).rejects.toMatchObject({ status: 401 });
    expect((await db.user.findUniqueOrThrow({ where: { username: "tanaka" } })).failedLoginCount).toBe(1);
  });

  it("一時停止の間は、再認証の有効時間の内でも、再認証が要る操作を断る", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 2 });
    const { secret, token } = await enrolledUser(ctx, clock, "admin1", "admin");
    const s = await sessionOf(db, token);
    await reauthenticate(ctx, s.session, s.user, { password: PASSWORD, code: totpAt(secret, clock.t) });
    const ok = await sessionOf(db, token);
    expect(() => assertRecentReauth(ctx, ok.session, ok.user)).not.toThrow();
    // ほかの人が、この利用者名でパスワードを続けて間違え、一時停止になる
    for (let i = 0; i < 2; i++) await login(ctx, "admin1", "wrong-pass-123").catch(() => undefined);
    const locked = await sessionOf(db, token);
    expect(locked.user.lockedUntil!.getTime()).toBeGreaterThan(clock.t);
    expect(() => assertRecentReauth(ctx, locked.session, locked.user)).toThrow(
      expect.objectContaining({ status: 403, problems: ["locked"] }),
    );
  });

  it("自分のログインの一時停止は、一時停止の有無に関わらず、自分では解けない（別の管理者が解く）", async () => {
    const { ctx, db } = await setup({ mfaRequired: false, loginLockThreshold: 2 });
    const a = await createUser(ctx, { ...SATO, username: "admin1", role: "admin" }, ADMIN);
    await createUser(ctx, { ...SATO, username: "admin2", role: "admin" }, ADMIN);
    const self = { actorId: "admin1", actorRole: "admin" };
    await expect(updateUser(ctx, a.id, { clearLoginLock: true }, self)).rejects.toMatchObject({ status: 403 });
    for (let i = 0; i < 2; i++) await login(ctx, "admin1", "wrong-pass-123").catch(() => undefined);
    await expect(updateUser(ctx, a.id, { clearLoginLock: true }, self)).rejects.toMatchObject({ status: 403 });
    expect((await db.user.findUniqueOrThrow({ where: { id: a.id } })).lockedUntil).not.toBeNull();
    // 別の管理者は解ける
    await updateUser(ctx, a.id, { clearLoginLock: true }, { actorId: "admin2", actorRole: "admin" });
    expect((await db.user.findUniqueOrThrow({ where: { id: a.id } })).lockedUntil).toBeNull();
  });

  it("F10：ログインし直したら前のセッションを消す。期限の切れたセッションを片付ける", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false });
    await createUser(ctx, SATO, ADMIN);
    await createUser(ctx, { ...SATO, username: "kato", displayName: "加藤", mustChangePassword: true }, ADMIN);
    const first = await login(ctx, "sato", SATO.password);
    const second = await login(ctx, "sato", SATO.password, first.token);
    expect(await db.session.findUnique({ where: { id: hashToken(first.token) } })).toBeNull();
    // 失敗したログインでは消さない
    await expect(login(ctx, "sato", "wrong-pass-1a", second.token)).rejects.toMatchObject({ status: 401 });
    expect(await db.session.findUnique({ where: { id: hashToken(second.token) } })).not.toBeNull();

    // 途中のセッション（10 分）だけが切れる
    const pending = await login(ctx, "kato", SATO.password);
    expect(pending.stage).toBe("change_password");
    clock.advance(11 * 60_000);
    expect(await purgeExpiredSessions(db, clock.now())).toBe(1);
    expect(await db.session.findUnique({ where: { id: hashToken(pending.token) } })).toBeNull();
    expect(await db.session.findUnique({ where: { id: hashToken(second.token) } })).not.toBeNull();
  });

  it("F7：ログインの失敗の答えは、利用者名の有無・理由によらず、決めた時間より前には返さない", async () => {
    const { ctx } = await setup({ mfaRequired: false });
    ctx.loginFailureFloorMs = 80;
    await createUser(ctx, SATO, ADMIN);
    await createUser(ctx, { ...SATO, username: "kato", displayName: "加藤" }, ADMIN);
    const kato = await ctx.db.user.findUniqueOrThrow({ where: { username: "kato" } });
    await ctx.db.user.update({ where: { id: kato.id }, data: { status: "disabled" } });
    for (const name of ["nobody", "sato", "kato"]) {
      const t0 = performance.now();
      await expect(login(ctx, name, "wrong-pass-1a")).rejects.toMatchObject({ status: 401 });
      // タイマーの丸めの分だけ、少しの余裕を見る
      expect(performance.now() - t0).toBeGreaterThanOrEqual(78);
    }
  });

  it("F11：保存したハッシュが弱ければ、ログインに成功したときに作り直す（パスワードの変更の時刻は変えない）", async () => {
    const { ctx, db } = await setup({ mfaRequired: false });
    const u = await createUser(ctx, SATO, ADMIN);
    const weak = await hashPassword(SATO.password, { memory: 8192, passes: 1, parallelism: 1 });
    await db.user.update({ where: { id: u.id }, data: { passwordHash: weak } });
    // 違うパスワードでは作り直さない
    await expect(login(ctx, "sato", "wrong-pass-1a")).rejects.toMatchObject({ status: 401 });
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe(weak);

    expect((await login(ctx, "sato", SATO.password)).stage).toBe("active");
    const after = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    const { memory, passes, parallelism } = DEFAULT_ARGON2_PARAMS;
    expect(after.passwordHash).toContain(`$m=${memory},t=${passes},p=${parallelism}$`);
    expect(after.passwordChangedAt).toEqual(u.passwordChangedAt);
    expect((await login(ctx, "sato", SATO.password)).stage).toBe("active");
  });
});
