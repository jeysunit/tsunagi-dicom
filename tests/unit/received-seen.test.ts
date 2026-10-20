import { describe, expect, it } from "vitest";
import { isNewArrival, latestReceivedAt, RECEIVED_SEEN_KEY, rememberSeen } from "@/lib/client/received-seen";

// 受信一覧の「新着」の印（docs/spec.md の 3.3。2026-10-21）

describe("新着の印", () => {
  it("前に見た受信日時より後に受信したものだけ。前に見た日時が無い・読めないときは、どれも新着にしない", () => {
    expect(isNewArrival("2026-10-17T13:32:00Z", "2026-10-17T12:00:00Z")).toBe(true);
    expect(isNewArrival("2026-10-17T12:00:00Z", "2026-10-17T12:00:00Z")).toBe(false);
    expect(isNewArrival("2026-10-17T11:00:00Z", "2026-10-17T12:00:00Z")).toBe(false);
    expect(isNewArrival("2026-10-17T13:32:00Z", null)).toBe(false);
    expect(isNewArrival("2026-10-17T13:32:00Z", "壊れた値")).toBe(false);
    expect(isNewArrival(undefined, "2026-10-17T12:00:00Z")).toBe(false);
  });

  it("覚えた値が日時として読めないときは、上書きして直す。読める値は、古い値で上書きしない", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    globalThis.window = { localStorage: storage } as unknown as Window & typeof globalThis;
    try {
      store.set(RECEIVED_SEEN_KEY, "壊れた値");
      rememberSeen("2026-10-17T13:32:00Z");
      expect(store.get(RECEIVED_SEEN_KEY)).toBe("2026-10-17T13:32:00Z");
      rememberSeen("2026-10-17T12:00:00Z");
      expect(store.get(RECEIVED_SEEN_KEY)).toBe("2026-10-17T13:32:00Z");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("次に開いたときの基準は、いちばん新しい受信日時（読めない値は飛ばす）", () => {
    expect(latestReceivedAt(["2026-10-17T09:01:00Z", "2026-10-17T13:32:00Z", undefined, "x", "2026-10-17T12:31:00Z"])).toBe(
      "2026-10-17T13:32:00Z",
    );
    expect(latestReceivedAt([])).toBeNull();
  });
});
