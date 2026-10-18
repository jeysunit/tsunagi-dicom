import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { verifyAuditChain } from "@/lib/audit";
import { bootstrapInitialAdmin, BootstrapError } from "@/lib/auth/bootstrap";
import {
  AuthFailure,
  changePassword,
  confirmEnrollment,
  createUser,
  hashToken,
  listUsers,
  lockScreen,
  login,
  logout,
  resolveSession,
  SERVER_LOCK_GRACE_SECONDS,
  startEnrollment,
  submitTotp,
  unlockScreen,
  updateUser,
  type AuthContext,
  type AuthSettings,
} from "@/lib/auth/local-auth";
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

async function setup(settings: Partial<AuthSettings> = {}) {
  const db = await dbs.fresh();
  const clock = new Clock();
  const ctx: AuthContext = {
    db,
    settings: {
      mfaRequired: true,
      loginLockThreshold: 3,
      loginLockMinutes: 15,
      screenLockMinutes: 15,
      sessionSecret: SESSION_SECRET,
      ...settings,
    },
    source: { sourceAddress: null, sourceAddressUnverified: "198.51.100.7" },
    now: clock.now,
  };
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
  expect(await confirmEnrollment(ctx, s2.session, s2.user, totpAt(secret, clock.t))).toBe("active");
  // 次の TOTP は次の段で（使い回しは断る）
  clock.advance(30_000);
  return { secret, token: first.token };
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
    expect(await submitTotp(ctx, pending.session, pending.user, totpAt(secret, clock.t))).toBe("active");
    expect((await resolveSession(ctx, second.token)).kind).toBe("active");

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
    expect(await submitTotp(ctx, sa.session, sa.user, code)).toBe("active");
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
    expect(await changePassword(ctx, s.session, s.user, { newPassword: "zr4tx8pe-next-1" })).toBe("active");
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

  it("TOTP の失敗も同じに数え、一時停止になったら途中のセッションも消す", async () => {
    const { ctx, db, clock } = await setup({ loginLockThreshold: 2 });
    await enrolledUser(ctx, clock);
    const r = await login(ctx, "tanaka", PASSWORD);
    const s = await sessionOf(db, r.token);
    await expect(submitTotp(ctx, s.session, s.user, "000000")).rejects.toMatchObject({ problems: [] });
    const s2 = await sessionOf(db, r.token);
    await expect(submitTotp(ctx, s2.session, s2.user, "000001")).rejects.toMatchObject({ problems: ["locked"] });
    expect((await resolveSession(ctx, r.token)).kind).toBe("anonymous");
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
  it("ロックしたら、解くまでセッションはロックのまま。解くにはパスワードと TOTP が要る", async () => {
    const { ctx, db, clock } = await setup();
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
  });

  it("操作の無い時間が続いたら、サーバーの側でもロックにする（画面の時間＋猶予）", async () => {
    const { ctx, clock } = await setup({ mfaRequired: false, screenLockMinutes: 15 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    clock.advance(15 * 60_000);
    expect((await resolveSession(ctx, token)).kind).toBe("active");
    clock.advance(SERVER_LOCK_GRACE_SECONDS * 1000);
    expect((await resolveSession(ctx, token)).kind).toBe("locked");
  });

  it("SCREEN_LOCK_MINUTES=0 ならロックしない", async () => {
    const { ctx, clock } = await setup({ mfaRequired: false, screenLockMinutes: 0 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    clock.advance(11 * 60 * 60_000);
    expect((await resolveSession(ctx, token)).kind).toBe("active");
  });

  it("解く失敗も一時停止に数え、一時停止になったらセッションを消す", async () => {
    const { ctx, db, clock } = await setup({ mfaRequired: false, loginLockThreshold: 2 });
    await createUser(ctx, { username: "sato", displayName: "佐藤", role: "viewer", password: "kq7vz2mw-long1", mustChangePassword: false }, ADMIN);
    const { token } = await login(ctx, "sato", "kq7vz2mw-long1");
    const s = await sessionOf(db, token);
    await lockScreen(ctx, s.session, s.user, "manual");
    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({ problems: [] });
    await expect(unlockScreen(ctx, s.session, s.user, { password: "wrong-pass-123" })).rejects.toMatchObject({
      problems: ["locked"],
    });
    expect((await resolveSession(ctx, token)).kind).toBe("anonymous");
    clock.advance(16 * 60_000);
    expect((await login(ctx, "sato", "kq7vz2mw-long1")).stage).toBe("active");
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
