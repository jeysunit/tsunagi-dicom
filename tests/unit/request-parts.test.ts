import { describe, expect, it } from "vitest";
import { readLimitedText } from "@/lib/api/body";
import { sourceFromHeaders } from "@/lib/auth/source-address";
import { shareUntilFailure } from "@/lib/db";

describe("監査の記録の接続元", () => {
  it("X-Forwarded-For は確かめていない欄に分け、確かめた接続元は空にする（信じるプロキシの設定が無い間）", () => {
    const h = new Headers({ "x-forwarded-for": "198.51.100.7, 192.0.2.10", "x-real-ip": "192.0.2.10" });
    expect(sourceFromHeaders(h)).toEqual({ sourceAddress: null, sourceAddressUnverified: "198.51.100.7, 192.0.2.10" });
  });

  it("X-Forwarded-For が無ければ X-Real-IP、どちらも無ければ両方とも空", () => {
    expect(sourceFromHeaders(new Headers({ "x-real-ip": "192.0.2.10" }))).toEqual({
      sourceAddress: null,
      sourceAddressUnverified: "192.0.2.10",
    });
    expect(sourceFromHeaders(new Headers())).toEqual({ sourceAddress: null, sourceAddressUnverified: null });
    expect(sourceFromHeaders(new Headers({ "x-forwarded-for": "   " }))).toEqual({
      sourceAddress: null,
      sourceAddressUnverified: null,
    });
  });

  it("長すぎる値は切る", () => {
    const long = Array.from({ length: 100 }, () => "192.0.2.10").join(", ");
    expect(sourceFromHeaders(new Headers({ "x-forwarded-for": long })).sourceAddressUnverified).toHaveLength(256);
  });
});

describe("データベースのつなぎ", () => {
  it("つなぐのに失敗したら覚えず、次の呼び出しでつなぎ直す", async () => {
    let calls = 0;
    const get = shareUntilFailure(async () => {
      calls += 1;
      if (calls === 1) throw new Error("unable to open database file");
      return { n: calls };
    });
    await expect(get()).rejects.toThrow("unable to open database file");
    expect(await get()).toEqual({ n: 2 });
    // つながったものは使い回す
    expect(await get()).toEqual({ n: 2 });
    expect(calls).toBe(2);
  });
});

describe("要求の本文の大きさ", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("http://127.0.0.1/api/dev/role", { method: "POST", body, headers, duplex: "half" } as RequestInit);

  it("決めた大きさまでなら読む", async () => {
    expect(await readLimitedText(post('{"role":"admin"}'), 1024)).toBe('{"role":"admin"}');
  });

  it("content-length が大きければ読まずに断る", async () => {
    expect(await readLimitedText(post("x", { "content-length": "4096" }), 1024)).toBeNull();
  });

  it("content-length が無くても、読んだ量で止める", async () => {
    const chunks = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 10; i++) controller.enqueue(new Uint8Array(512));
        controller.close();
      },
    });
    expect(await readLimitedText(post(chunks), 1024)).toBeNull();
  });
});
