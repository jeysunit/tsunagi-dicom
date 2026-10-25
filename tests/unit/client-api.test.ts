import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getJson, NETWORK_ERROR_MESSAGE } from "@/lib/client/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getJson の通信の誤り", () => {
  it("通信が切れたときは、ブラウザーの英語の誤りでなく、日本語の文の ApiError（status 0）にする", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const error = await getJson("/api/studies").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).message).toBe(NETWORK_ERROR_MESSAGE);
    expect((error as ApiError).message).not.toMatch(/fetch/i);
  });

  it("取り消し（AbortError）はそのまま渡す。画面を離れたときに誤りの文を出さない", async () => {
    const abort = new DOMException("aborted", "AbortError");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(abort));
    await expect(getJson("/api/studies", new AbortController().signal)).rejects.toBe(abort);
  });

  it("サーバーが返した誤りの文は、これまでどおり出す", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "画像サーバーに接続できません" }), { status: 502 })));
    await expect(getJson("/api/studies")).rejects.toMatchObject({ status: 502, message: "画像サーバーに接続できません" });
  });
});
