import { Socket } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createReceiver } from "../../hl7-receiver/receiver";
afterEach(() => vi.unstubAllGlobals());

it("届けられない知らせは3回再送して数え、次の成功の直後に dropped を送る", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    if (bodies.length <= 4) {
      throw Error("offline");
    }
    return Response.json({ ok: true });
  });
  vi.stubGlobal("fetch", fetcher);
  const log = vi.fn();
  const server = createReceiver({
    allowedSources: ["192.0.2.100"],
    forwardUrl: "http://localhost",
    token: "synthetic",
    retryDelaysMs: [1, 1, 1],
    log
  });
  const connection = (peer: string) => {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: peer });
    server.emit("connection", socket);
    return socket;
  };
  connection("192.0.2.1");
  await vi.waitFor(() => expect(log).toHaveBeenCalledWith("HL7 知らせを渡せない 192.0.2.1"));
  connection("192.0.2.2");
  await vi.waitFor(() => expect(bodies).toHaveLength(6));
  expect(bodies.slice(0, 4)).toEqual(Array(4).fill({ peer: "192.0.2.1", event: "refused" }));
  expect(bodies[4]).toEqual({ peer: "192.0.2.2", event: "refused" });
  expect(bodies[5]).toMatchObject({
    peer: "hl7-receiver",
    event: "dropped",
    count: 1,
    since: expect.any(String),
    until: expect.any(String)
  });
  expect(fetcher.mock.calls.every(([, init]) => init.redirect === "error")).toBe(true);
  server.emit("close");
});

it("既定の8接続は保ち、9本目を閉じて busy の数を送る", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true });
  }));
  const server = createReceiver({
    allowedSources: ["192.0.2.1"],
    forwardUrl: "http://localhost",
    token: "synthetic",
    aggregationMs: 5,
    log: () => undefined,
  });
  const sockets: Socket[] = [];
  try {
    // 待ち受けを使わず、接続数の既定値と知らせを確かめる（design.md §12）。
    for (let i = 0; i < 9; i++) {
      const socket = new Socket();
      Object.defineProperty(socket, "remoteAddress", { value: "192.0.2.1" });
      sockets.push(socket);
      server.emit("connection", socket);
    }
    expect(sockets.slice(0, 8).every(socket => !socket.destroyed)).toBe(true);
    expect(sockets[8]!.destroyed).toBe(true);
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      peer: "192.0.2.1", event: "busy", count: 1,
      since: expect.any(String), until: expect.any(String),
    });
  } finally {
    sockets.forEach(socket => socket.destroy());
    server.emit("close");
  }
});

it("名前の時間切れ後も未完了の8件を保ち、新しい問い合わせを始めない", async () => {
  const resolve = vi.fn(() => new Promise<readonly { address: string }[]>(() => undefined));
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ ok: true });
  }));
  const server = createReceiver({
    allowedSources: ["pacs.example.org"],
    forwardUrl: "http://localhost",
    token: "synthetic",
    resolve,
    dnsTimeoutMs: 1,
    aggregationMs: 5,
    log: () => undefined
  });
  for (let i = 0; i < 12; i++) {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: "192.0.2.1" });
    server.emit("connection", socket);
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  }
  expect(resolve).toHaveBeenCalledTimes(8);
  await vi.waitFor(() => expect(bodies.filter(body => body.event === "busy")
    .reduce((count, body) => count + Number(body.count), 0)).toBe(4));
  server.emit("close");
});

it("100件の枠の誤りは64件まで持ち、復旧後に溢れた36件をまとめて知らせる", async () => {
  const bodies: Record<string, unknown>[] = [];
  const releases: (() => void)[] = [];
  let online = false;
  let active = 0;
  let peak = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    active++;
    peak = Math.max(peak, active);
    if (!online) {
      await new Promise<void>(resolve => releases.push(resolve));
    }
    active--;
    return Response.json({ ok: true });
  }));
  const server = createReceiver({
    allowedSources: ["192.0.2.1"],
    forwardUrl: "http://localhost",
    token: "synthetic",
    log: () => undefined
  });
  const since = new Date().toISOString();
  for (let i = 0; i < 100; i++) {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: "192.0.2.1" });
    server.emit("connection", socket);
    // 許可の確かめが済んでから、枠の外の字を渡す。
    await Promise.resolve();
    await Promise.resolve();
    socket.emit("data", Buffer.from("x"));
    await new Promise<void>(resolve => socket.once("close", resolve));
  }
  const until = new Date().toISOString();
  expect(bodies).toHaveLength(2);
  expect(peak).toBe(2);
  online = true;
  releases.forEach(release => release());
  await vi.waitFor(() => expect(bodies).toHaveLength(65));
  expect(bodies.filter(body => body.event === "framing")).toHaveLength(64);
  const summaries = bodies.filter(body => body.event === "dropped");
  expect(summaries).toEqual([{
    peer: "hl7-receiver",
    event: "dropped",
    count: 36,
    since: expect.any(String),
    until: expect.any(String)
  }]);
  expect(String(summaries[0]!.since) >= since).toBe(true);
  expect(String(summaries[0]!.until) <= until).toBe(true);
  expect(peak).toBe(2);
  server.emit("close");
});

it("24回の送信と切断でも転送は8件までで、切断ごとに中止し、終了まで枠を保つ", async () => {
  const signals: AbortSignal[] = [];
  const releases: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    if (!JSON.parse(String(init.body)).message) {
      return Response.json({ ok: true });
    }
    signals.push(init.signal!);
    active++;
    peak = Math.max(peak, active);
    try {
      // 中止から fetch が終了するまでの間も枠を保つ。
      await new Promise<never>((_, reject) => releases.push(() => reject(new Error("aborted"))));
    } finally {
      active--;
    }
    return Response.json({});
  }));
  const server = createReceiver({
    allowedSources: ["192.0.2.1"],
    forwardUrl: "http://localhost",
    token: "synthetic",
    log: () => undefined
  });
  const connection = async () => {
    const socket = new Socket();
    Object.defineProperty(socket, "remoteAddress", { value: "192.0.2.1" });
    server.emit("connection", socket);
    await Promise.resolve();
    await Promise.resolve();
    return socket;
  };
  try {
    for (let i = 0; i < 24; i++) {
      const socket = await connection();
      socket.emit("data", Buffer.from("\x0bbody\x1c\r"));
      const closed = new Promise<void>(resolve => socket.once("close", resolve));
      socket.destroy();
      await closed;
      expect(signals.every(signal => signal.aborted)).toBe(true);
      expect(active).toBeLessThanOrEqual(8);
    }
    expect(signals).toHaveLength(8);
    expect(active).toBe(8);
    expect(peak).toBe(8);
    releases.splice(0).forEach(release => release());
    await vi.waitFor(() => expect(active).toBe(0));
    const next = await connection();
    next.emit("data", Buffer.from("\x0bbody\x1c\r"));
    expect(signals).toHaveLength(9);
    const closed = new Promise<void>(resolve => next.once("close", resolve));
    next.destroy();
    await closed;
    expect(signals[8]!.aborted).toBe(true);
  } finally {
    releases.forEach(release => release());
    server.emit("close");
  }
});

it("ACK の write が返らなくても期限で閉じ、接続枠を解放する", async () => {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({ ack: Buffer.from("ACK").toString("base64") });
  }));
  const server = createReceiver({
    allowedSources: ["192.0.2.1"],
    forwardUrl: "http://localhost",
    token: "synthetic",
    maxConnections: 1,
    readTimeoutMs: 20,
    log: () => undefined
  });
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: "192.0.2.1" });
  const write = vi.spyOn(socket, "write").mockImplementation(() => true);
  server.emit("connection", socket);
  await Promise.resolve();
  await Promise.resolve();
  socket.emit("data", Buffer.from("\x0bbody\x1c\r"));
  await vi.waitFor(() => expect(socket.destroyed).toBe(true));
  expect(write).toHaveBeenCalledTimes(1);
  expect(bodies).toEqual([
    { peer: "192.0.2.1", message: Buffer.from("body").toString("base64") },
    { peer: "192.0.2.1", event: "timeout" }
  ]);
  const next = new Socket();
  Object.defineProperty(next, "remoteAddress", { value: "192.0.2.1" });
  server.emit("connection", next);
  expect(next.destroyed).toBe(false);
  next.destroy();
  server.emit("close");
});
