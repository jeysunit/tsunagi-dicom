import { describe, expect, it } from "vitest";
import { decideWrite, DEV_WRITE_BLOCKED_MESSAGE, isWriteMethod } from "@/lib/auth/write-guard";

describe("書き込みの止め（AUTH_MODE=dev）", () => {
  it("検証モードでは既定で書き込みを止める", () => {
    expect(decideWrite({ mode: "dev", devAllowWrite: false })).toEqual({
      allowed: false,
      reason: DEV_WRITE_BLOCKED_MESSAGE,
    });
  });

  it("DEV_ALLOW_WRITE=true のときだけ通す", () => {
    expect(decideWrite({ mode: "dev", devAllowWrite: true })).toEqual({ allowed: true });
  });

  it("読むだけの method は書き込みにあたらない", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) expect(isWriteMethod(m)).toBe(false);
    for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(isWriteMethod(m)).toBe(true);
  });
});
