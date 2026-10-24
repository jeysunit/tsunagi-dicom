import { beforeEach, describe, expect, it, vi } from "vitest";

// /api/auth/logout（src/app/api/auth/logout/route.ts）：ロック中（state.kind=locked）のログアウトだけ、監査の記録に
// from: screen_lock を残す。ロック中かどうかは BFF の状態で決める。CSRF の不一致は、セッションも cookie も触らず断る。

const mocks = vi.hoisted(() => ({
  checkedState: vi.fn(),
  clearSessionCookie: vi.fn(async () => {}),
  clearLockCookie: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
}));

vi.mock("@/lib/api/auth-route", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api/auth-route")>();
  return {
    ...real,
    checkedState: mocks.checkedState,
    clearSessionCookie: mocks.clearSessionCookie,
    clearLockCookie: mocks.clearLockCookie,
  };
});
vi.mock("@/lib/auth/local-auth", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/local-auth")>();
  return { ...real, logout: mocks.logout };
});
vi.mock("@/lib/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...real, authContext: async () => ({ marker: "ctx" }) };
});

const local = { row: { id: "row" }, user: { username: "sato", role: "general" } };
const post = async () => {
  const { POST } = await import("@/app/api/auth/logout/route");
  return POST(new Request("http://127.0.0.1/api/auth/logout", { method: "POST" }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/logout", () => {
  it("ロック中のログアウトは fromScreenLock: true で記録し、セッションとロックの印を消す", async () => {
    mocks.checkedState.mockResolvedValue({ kind: "locked", session: { local } });
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ next: "/login" });
    expect(mocks.logout).toHaveBeenCalledWith({ marker: "ctx" }, local.row, local.user, { fromScreenLock: true });
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.clearLockCookie).toHaveBeenCalledOnce();
  });

  it("ロックしていないログアウトは fromScreenLock: false", async () => {
    mocks.checkedState.mockResolvedValue({ kind: "active", session: { local } });
    await post();
    expect(mocks.logout).toHaveBeenCalledWith({ marker: "ctx" }, local.row, local.user, { fromScreenLock: false });
  });

  it("ログインの途中のログアウトは fromScreenLock: false", async () => {
    mocks.checkedState.mockResolvedValue({ kind: "pending", stage: "totp", row: local.row, user: local.user });
    await post();
    expect(mocks.logout).toHaveBeenCalledWith({ marker: "ctx" }, local.row, local.user, { fromScreenLock: false });
  });

  it("CSRF の token が合わなければ 403 で断り、セッションも cookie も触らない", async () => {
    const { RequestError } = await import("@/lib/api/auth-route");
    mocks.checkedState.mockRejectedValue(new RequestError(403, "画面の確認用の token（x-csrf-token）が一致しません。頁を開き直してください"));
    const res = await post();
    expect(res.status).toBe(403);
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
    expect(mocks.clearLockCookie).not.toHaveBeenCalled();
  });
});
