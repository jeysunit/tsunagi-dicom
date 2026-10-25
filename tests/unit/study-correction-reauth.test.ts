import { describe, expect, it, vi } from "vitest";
import type { Session } from "@/lib/auth/session";

// 値の修正の道の再認証（AUTH_MODE=local）。検証モード（dev）は再認証を求めない。local では、直前の再認証が無ければ
// 403（problems に reauth_required）で断り、画面が再認証の欄を出せるようにする。

const REAUTH_MINUTES = 5;
const clock = vi.hoisted(() => ({ t: Date.parse("2026-10-26T00:00:00Z") }));

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...real,
    authContext: async () => ({ settings: { reauthMinutes: REAUTH_MINUTES }, now: () => new Date(clock.t) }),
  };
});

type LocalSession = NonNullable<Session["local"]>;
const sessionWith = (reauthAt: Date | null): Session =>
  ({
    local: {
      row: { reauthAt, reauthMfaAt: null, reauthRoleVersion: 1 },
      user: { lockedUntil: null, totpSecretEnc: null, roleVersion: 1 },
    } as unknown as LocalSession,
  }) as Session;

describe("値の修正の再認証", () => {
  it("検証モード（local のセッションが無い）は再認証を求めない", async () => {
    const { assertReauth } = await import("@/app/api/studies/[uid]/modify/shared");
    await expect(assertReauth({} as Session)).resolves.toBeUndefined();
  });

  it("local で再認証していなければ 403（reauth_required）", async () => {
    const { assertReauth } = await import("@/app/api/studies/[uid]/modify/shared");
    await expect(assertReauth(sessionWith(null))).rejects.toMatchObject({ status: 403, problems: ["reauth_required"] });
  });

  it("再認証の有効時間を過ぎていれば 403、中なら通る", async () => {
    const { assertReauth } = await import("@/app/api/studies/[uid]/modify/shared");
    await expect(assertReauth(sessionWith(new Date(clock.t - (REAUTH_MINUTES * 60 + 1) * 1000)))).rejects.toMatchObject({
      status: 403,
      problems: ["reauth_required"],
    });
    await expect(assertReauth(sessionWith(new Date(clock.t - 60_000)))).resolves.toBeUndefined();
  });
});
