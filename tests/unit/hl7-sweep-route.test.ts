import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type AppConfig } from "@/lib/config";
import { startSweeper } from "../../hl7-receiver/sweep";
const state = vi.hoisted(() => ({
  config: undefined as AppConfig | undefined,
  sweep: vi.fn()
}));
vi.mock("@/lib/config", async (original) => ({
  ...await original<typeof import("@/lib/config")>(),
  getConfig: () => state.config!
}));
vi.mock("@/lib/hl7/sweep", async (original) => ({
  ...await original<typeof import("@/lib/hl7/sweep")>(),
  sweepArrivals: state.sweep
}));
import { POST } from "@/app/api/hl7/sweep/route";
const token = randomBytes(32).toString("hex");
const req = (authorization: string | null = `Bearer ${token}`) => new Request("http://localhost/api/hl7/sweep", {
  method: "POST",
  headers: { ...(authorization === null ? {} : { authorization }), cookie: "session=admin" }
});
beforeEach(() => {
  vi.clearAllMocks();
  state.config = {
    ...loadConfig({ BACKEND_MOCK: "true", AUTH_MODE: "dev", SESSION_SECRET: "x".repeat(48) }),
    hl7ReceiverToken: token
  };
  state.sweep.mockResolvedValue({ count: 2, skipped: 1 });
});

describe("照合の後の画像の見回りの道（/api/hl7/sweep）", () => {
  it("token が合えば見回りを 1 回流し、数を返す", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 2, skipped: 1 });
    expect(state.sweep).toHaveBeenCalledTimes(1);
  });
  it("設定が無ければ 404", async () => {
    delete state.config!.hl7ReceiverToken;
    expect((await POST(req())).status).toBe(404);
    expect(state.sweep).not.toHaveBeenCalled();
  });
  it.each([null, "Bearer wrong", "Basic value"])("token が違えば、セッションがあっても 401（%s）", async (auth) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await POST(req(auth))).status).toBe(401);
      expect(state.sweep).not.toHaveBeenCalled();
      expect(warn.mock.calls.flat().join("")).not.toContain(token);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("受け口の見回りの呼び出し", () => {
  it("token を付けて定期に呼び、前の呼び出しが終わるまで重ねない", async () => {
    let calls = 0;
    let inFlight = 0;
    let overlapped = false;
    const seen: (string | undefined)[] = [];
    const server = createServer((request, response) => {
      calls++;
      inFlight++;
      overlapped ||= inFlight > 1;
      seen.push(request.headers.authorization);
      setTimeout(() => {
        inFlight--;
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      }, 40);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const stop = startSweeper({
      url: `http://127.0.0.1:${port}/api/hl7/sweep`,
      token,
      intervalMs: 10,
      timeoutMs: 1000,
      firstDelayMs: 1,
      log: () => undefined
    });
    await new Promise(resolve => setTimeout(resolve, 200));
    stop();
    await new Promise(resolve => setTimeout(resolve, 60));
    server.close();
    expect(calls).toBeGreaterThan(1);
    expect(overlapped).toBe(false);
    expect(new Set(seen)).toEqual(new Set([`Bearer ${token}`]));
  });
  it("BFF が誤りを返しても止まらず、ログに token を出さない", async () => {
    const lines: string[] = [];
    let calls = 0;
    const server = createServer((_request, response) => {
      calls++;
      response.writeHead(500).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const stop = startSweeper({
      url: `http://127.0.0.1:${port}/api/hl7/sweep`,
      token,
      intervalMs: 10,
      timeoutMs: 1000,
      firstDelayMs: 1,
      log: line => lines.push(line)
    });
    await new Promise(resolve => setTimeout(resolve, 100));
    stop();
    server.close();
    expect(calls).toBeGreaterThan(1);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toContain(token);
  });
});
