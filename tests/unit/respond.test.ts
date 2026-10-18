import { describe, expect, it } from "vitest";
import { errorResponse } from "@/lib/api/respond";
import { AuthFailure, HASH_BUSY_MESSAGE } from "@/lib/auth/local-auth";

// 失敗の答え（src/lib/api/respond.ts）。パスワードの確かめが混んで断ったときは 503 と Retry-After。

describe("失敗の答え", () => {
  it("混んで断ったときは 503 と Retry-After を付ける", async () => {
    const res = errorResponse(new AuthFailure(503, HASH_BUSY_MESSAGE, ["busy"], 5));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).toEqual({ error: HASH_BUSY_MESSAGE, problems: ["busy"] });
  });

  it("ほかの失敗には Retry-After を付けない", () => {
    const res = errorResponse(new AuthFailure(401, "違う"));
    expect(res.status).toBe(401);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});
