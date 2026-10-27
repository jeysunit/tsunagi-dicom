import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { verifyAuditChain } from "@/lib/audit";

// 監査の記録の鍵は設定から導く。この試験では試験だけの値にする（tests/unit/helpers/audit-config.ts）
vi.mock("@/lib/config", async (importOriginal) => (await import("./helpers/audit-config")).withAuditKey(await importOriginal()));
import { generateTemporaryPassword, resetAdminPassword, type ResetOptions } from "@/lib/auth/admin-reset";
import { FailureDigest } from "@/lib/auth/failure-digest";
import { HashLimiter } from "@/lib/auth/hash-limiter";
import {
  confirmEnrollment,
  createUser,
  hashToken,
  login,
  PENDING_SESSION_MINUTES,
  REAUTH_MINUTES,
  resolveSession,
  SESSION_MAX_HOURS,
  startEnrollment,
  submitTotp,
  type AuthContext,
} from "@/lib/auth/local-auth";
import { checkPassword } from "@/lib/auth/password-policy";
import { LoginThrottle } from "@/lib/auth/rate-limit";
import { totpAt } from "@/lib/auth/totp";
import type { Db } from "@/lib/db";
import { run, type CliContext, type CliDeps } from "@/cli/reset-admin-password";
import { testDatabases } from "./helpers/test-db";

// 管理者のパスワードを失くしたときの戻し方（docs/spec.md の 3.6）を、migration を流した本物の SQLite に対して確かめる。

const dbs = testDatabases("tsunagi-admin-reset-");
beforeAll(() => dbs.setup(), 60_000);
afterEach(() => dbs.closeAll());
afterAll(() => dbs.teardown());

const OLD_PASSWORD = "kq7vz2mw-pass";
const TEMP_PASSWORD = "tmp7rk3x-wq9m-hd4n-zb6p";
const SYSTEM = { actorId: "system", actorRole: "none" };
const OPERATOR = { osUser: "node", hostname: "tsunagi-1" };

class Clock {
  constructor(public t = new Date("2026-10-25T09:00:00Z").getTime()) {}
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
}

async function setup(mfaRequired = true) {
  const db = await dbs.fresh();
  const clock = new Clock();
  const ctx: AuthContext = {
    db,
    settings: {
      mfaRequired,
      loginLockThreshold: 3,
      loginLockMinutes: 15,
      screenLockMinutes: 15,
      screenUnlockRequireTotp: false,
      sessionSecret: "s".repeat(48),
      rateLimitPerUserPerMinute: 1000,
      rateLimitGlobalPerMinute: 1000,
      passwordHashConcurrency: 2,
      passwordHashQueue: 1000,
      pendingSessionMinutes: PENDING_SESSION_MINUTES,
      sessionMaxHours: SESSION_MAX_HOURS,
      reauthMinutes: REAUTH_MINUTES,
    },
    source: { sourceAddress: null, sourceAddressUnverified: null },
    now: clock.now,
    loginThrottle: new LoginThrottle(),
    sleep: async () => {},
    failureDigest: new FailureDigest(),
    loginFailureFloorMs: 0,
  };
  ctx.hashLimiter = new HashLimiter({ concurrency: 2, queueLimit: 1000 });
  return { db, ctx, clock };
}

async function sessionOf(db: Db, token: string) {
  const row = await db.session.findUniqueOrThrow({ where: { id: hashToken(token) }, include: { user: true } });
  const { user, ...session } = row;
  return { session, user };
}

/** TOTP を登録した管理者を作り、その秘密といまのセッションの token を返す */
async function enrolledAdmin(ctx: AuthContext, clock: Clock, username = "admin1") {
  await createUser(ctx, { username, displayName: "管理者", role: "admin", password: OLD_PASSWORD, mustChangePassword: false }, SYSTEM);
  const first = await login(ctx, username, OLD_PASSWORD);
  const { session, user } = await sessionOf(ctx.db, first.token);
  const { secret } = await startEnrollment(ctx, session, user);
  const s2 = await sessionOf(ctx.db, first.token);
  const done = await confirmEnrollment(ctx, s2.session, s2.user, totpAt(secret, clock.t));
  clock.advance(30_000);
  return { secret, token: done.rotated!.token };
}

const reset = (ctx: AuthContext, options: Partial<ResetOptions> = {}) =>
  resetAdminPassword(ctx, { username: "admin1", operator: OPERATOR, generatePassword: () => TEMP_PASSWORD, ...options });

describe("管理者のパスワードを戻す", () => {
  it("一時のパスワードに替え、古いパスワードは使えず、次のログインで変更を求める。TOTP は残す", async () => {
    const { ctx, db, clock } = await setup();
    const { secret, token } = await enrolledAdmin(ctx, clock);
    expect((await resolveSession(ctx, token)).kind).toBe("active");
    const before = await db.user.findUniqueOrThrow({ where: { username: "admin1" } });

    const result = await reset(ctx);

    expect(result).toEqual({ username: "admin1", password: TEMP_PASSWORD, totpReset: false, hadTotp: true, sessionsClosed: 1 });
    const after = await db.user.findUniqueOrThrow({ where: { username: "admin1" } });
    expect(after.mustChangePassword).toBe(true);
    expect(after.passwordHash).toMatch(/^\$argon2id\$/);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordHash).not.toContain(TEMP_PASSWORD);
    expect(after.credentialVersion).toBe(before.credentialVersion + 1);
    expect(after.totpSecretEnc).toBe(before.totpSecretEnc);

    // いまのセッションは閉じる
    expect((await resolveSession(ctx, token)).kind).toBe("anonymous");
    // 古いパスワードは通らない
    await expect(login(ctx, "admin1", OLD_PASSWORD)).rejects.toMatchObject({ status: 401 });
    // 一時のパスワードは通り、TOTP の段を経て、パスワードの変更の段になる
    const next = await login(ctx, "admin1", TEMP_PASSWORD);
    expect(next.stage).toBe("totp");
    const pending = await sessionOf(db, next.token);
    const done = await submitTotp(ctx, pending.session, pending.user, totpAt(secret, clock.t));
    expect(done.stage).toBe("change_password");
  });

  it("--reset-totp のときは TOTP も消し、次のログインで登録の段になる", async () => {
    const { ctx, db, clock } = await setup();
    await enrolledAdmin(ctx, clock);

    const result = await reset(ctx, { resetTotp: true });

    expect(result.totpReset).toBe(true);
    const after = await db.user.findUniqueOrThrow({ where: { username: "admin1" } });
    expect(after).toMatchObject({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, mustChangePassword: true });
    expect((await login(ctx, "admin1", TEMP_PASSWORD)).stage).toBe("enroll");
  });

  it("失敗の回数と一時停止を戻して、すぐログインできるようにする", async () => {
    const { ctx, db, clock } = await setup(false);
    await createUser(ctx, { username: "admin1", displayName: "管理者", role: "admin", password: OLD_PASSWORD, mustChangePassword: false }, SYSTEM);
    for (let i = 0; i < 3; i++) await login(ctx, "admin1", "wrong-pass-1").catch(() => undefined);
    const locked = await db.user.findUniqueOrThrow({ where: { username: "admin1" } });
    expect(locked.lockedUntil).not.toBeNull();

    await reset(ctx);

    const after = await db.user.findUniqueOrThrow({ where: { username: "admin1" } });
    expect(after).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
    clock.advance(1000);
    expect((await login(ctx, "admin1", TEMP_PASSWORD)).stage).toBe("change_password");
  });

  it("誰が・いつ・どの利用者をを監査の記録に残し、パスワードは残さない。記録のつなぎは壊れない", async () => {
    const { ctx, db, clock } = await setup();
    await enrolledAdmin(ctx, clock);
    clock.advance(60_000);

    await reset(ctx, { operator: { ...OPERATOR, operator: "保守担当" }, resetTotp: true });

    const rows = await db.auditLog.findMany({ where: { action: "admin_password_reset" } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      actorId: "container-cli",
      actorRole: "system",
      authMode: "local",
      outcome: "success",
      occurredAt: clock.now(),
    });
    expect(JSON.parse(row.detail!)).toEqual({
      target: "admin1",
      totpReset: true,
      sessionsClosed: 1,
      via: "container_cli",
      osUser: "node",
      hostname: "tsunagi-1",
      operator: "保守担当",
    });
    expect(JSON.stringify(await db.auditLog.findMany())).not.toContain(TEMP_PASSWORD);
    expect(await verifyAuditChain(db)).toMatchObject({ ok: true });
  });

  it.each([
    ["いない利用者", "nobody1", "not_found"],
    ["管理者でない利用者", "general1", "not_admin"],
    ["止めてある管理者", "admin2", "disabled"],
  ])("%s には使えず、断ったことを記録に残す", async (_label, username, reason) => {
    const { ctx, db } = await setup();
    await createUser(ctx, { username: "general1", displayName: "一般", role: "general", password: OLD_PASSWORD, mustChangePassword: false }, SYSTEM);
    const admin2 = await createUser(ctx, { username: "admin2", displayName: "管理者2", role: "admin", password: OLD_PASSWORD, mustChangePassword: false }, SYSTEM);
    await db.user.update({ where: { id: admin2.id }, data: { status: "disabled" } });
    const before = await db.user.findMany({ orderBy: { username: "asc" } });

    await expect(reset(ctx, { username })).rejects.toMatchObject({ name: "AdminResetError", reason });

    expect(await db.user.findMany({ orderBy: { username: "asc" } })).toEqual(before);
    const denied = await db.auditLog.findMany({ where: { action: "admin_password_reset" } });
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({ outcome: "denied", actorId: "container-cli" });
    expect(JSON.parse(denied[0]!.detail!)).toMatchObject({ target: username, reason, via: "container_cli" });
  });
});

describe("一時のパスワードの作り方", () => {
  it.each([true, false])("パスワードの規則に合い（MFA_REQUIRED=%s）、毎回違い、紛らわしい字を含まない", (mfa) => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const password = generateTemporaryPassword("admin1", mfa);
      expect(password).toMatch(/^[a-hj-km-np-z2-9]{6}(-[a-hj-km-np-z2-9]{6}){3}$/);
      expect(checkPassword(password, { mfaRequired: mfa, username: "admin1" })).toEqual([]);
      seen.add(password);
    }
    expect(seen.size).toBe(200);
  });
});

describe("コマンド", () => {
  function harness(overrides: Partial<CliDeps> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    let closed = 0;
    const calls: ResetOptions[] = [];
    const deps: CliDeps = {
      operator: OPERATOR,
      async open(): Promise<CliContext> {
        return { ctx: {} as AuthContext, close: async () => void closed++ };
      },
      ...overrides,
    };
    return { out, err, deps, closed: () => closed, calls, io: { out: (t: string) => void out.push(t), err: (t: string) => void err.push(t) } };
  }

  it("使い方の誤りは終了コード 2 で、何も開かない", async () => {
    for (const argv of [[], ["--user"], ["--user", "Bad Name"], ["--user", "admin1", "extra"], ["--nope"], ["--user", "admin1", "--operator", ""]]) {
      const h = harness({ open: vi.fn() });
      expect(await run(argv, h.io, h.deps)).toBe(2);
      expect(h.out).toEqual([]);
      expect(h.deps.open).not.toHaveBeenCalled();
    }
  });

  it("--help は使い方を標準出力に出して 0", async () => {
    const h = harness();
    expect(await run(["--help"], h.io, h.deps)).toBe(0);
    expect(h.out.join("")).toContain("使い方");
  });

  it("設定が合わない（AUTH_MODE が local でない など）ときは 2", async () => {
    const h = harness({
      open: async () => {
        throw new Error("AUTH_MODE=local のときだけ使えます");
      },
    });
    expect(await run(["--user", "admin1"], h.io, h.deps)).toBe(2);
    expect(h.out).toEqual([]);
    expect(h.err.join("")).toContain("AUTH_MODE=local");
  });

  it("戻したら、標準出力にはパスワードの1行だけを出し、説明は標準エラー出力に出す", async () => {
    const { ctx, db, clock } = await setup();
    await enrolledAdmin(ctx, clock);
    const h = harness({ open: async () => ({ ctx, close: async () => undefined }) });

    expect(await run(["--user", "admin1", "--operator", "保守担当"], h.io, h.deps)).toBe(0);

    expect(h.out).toHaveLength(1);
    const password = h.out[0]!;
    expect(password).toMatch(/^[a-z2-9-]{27}\n$/);
    expect(h.err.join("")).not.toContain(password.trim());
    expect(h.err.join("")).toContain("次のログインで");
    expect((await login(ctx, "admin1", password.trim())).stage).toBe("totp");
    const row = await db.auditLog.findFirstOrThrow({ where: { action: "admin_password_reset" } });
    expect(JSON.parse(row.detail!)).toMatchObject({ operator: "保守担当", osUser: "node" });
  });

  it("断られたら 1 で、標準出力には何も出さない。接続は閉じる", async () => {
    const { ctx } = await setup();
    const close = vi.fn(async () => undefined);
    const h = harness({ open: async () => ({ ctx, close }) });

    expect(await run(["--user", "nobody1"], h.io, h.deps)).toBe(1);

    expect(h.out).toEqual([]);
    expect(h.err.join("")).toContain("その利用者はいません");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
