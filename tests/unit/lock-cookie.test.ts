import { describe, expect, it } from "vitest";
import { LOCK_COOKIE, parseLockCookie } from "@/lib/auth/lock-cookie";

// 画面のロックの印の cookie（src/lib/auth/lock-cookie.ts）。どんな値でもロックの側に読む。

describe("画面のロックの印の cookie", () => {
  it("__Host- の名前で、無い・空なら印なし、それ以外はロック", () => {
    expect(LOCK_COOKIE.startsWith("__Host-")).toBe(true);
    expect(parseLockCookie(undefined)).toBeNull();
    expect(parseLockCookie("")).toBeNull();
    expect(parseLockCookie("client_idle")).toBe("client_idle");
    expect(parseLockCookie("manual")).toBe("manual");
    expect(parseLockCookie("anything-else")).toBe("manual");
  });
});
