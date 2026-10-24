import { createServer, type Server as HttpServer } from "node:http";
import { connect, type AddressInfo, type Server, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiver, matchesAllowlist, normalizeAddress, type ReceiverOptions } from "../../hl7-receiver/receiver";
const servers: (HttpServer | Server)[] = [];
const sockets: Socket[] = [];
const listen = async (server: Server | HttpServer) => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
};
const wait = async (predicate: () => boolean) => {
  const until = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > until) {
      throw new Error("試験の条件を待ちきれない");
    }
    await new Promise((r) => setTimeout(r, 2));
  }
};
afterEach(async () => {
  sockets.splice(0).forEach((s) => s.destroy());
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((resolve) => {
    s.close(() => resolve());
    if ("closeAllConnections" in s) {
      s.closeAllConnections();
    }
  })));
});

async function setup(options: Partial<ReceiverOptions> = {}, mode: "ok" | "error" | "bad" | "timeout" | "redirect" = "ok") {
  const bodies: Record<string, string>[] = [];
  const auth: string[] = [];
  const bff = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req)
      body += chunk;
    bodies.push(JSON.parse(body));
    auth.push(req.headers.authorization ?? "");
    if (mode === "timeout") {
      return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
      return;
    }
    res.writeHead(mode === "error" ? 500 : 200, { "content-type": "application/json" });
    const index = bodies.filter((b) => b.message).length;
    res.end(JSON.stringify(mode === "bad" ? {} : { ack: Buffer.from(`ACK${index}`).toString("base64") }));
  });
  const port = await listen(bff);
  const logs: string[] = [];
  const receiver = createReceiver({
    allowedSources: ["127.0.0.1"],
    forwardUrl: `http://127.0.0.1:${port}/api/hl7/messages`,
    token: "synthetic-token",
    readTimeoutMs: 200,
    forwardTimeoutMs: 100,
    maxMessageBytes: 256,
    log: (s) => logs.push(s),
    ...options
  });
  const tcpPort = await listen(receiver);
  const open = async () => {
    const socket = connect(tcpPort, "127.0.0.1");
    sockets.push(socket);
    const received: Buffer[] = [];
    socket.on("data", (b: Buffer) => received.push(b));
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    return { socket, data: () => Buffer.concat(received).toString() };
  };
  return { bodies, auth, logs, open };
}

describe("MLLP の受け口", () => {
  it(
    "空の一覧は待ち受けない",
    () => expect(() => createReceiver({ allowedSources: [], token: "", forwardUrl: "" })).toThrow("HL7_ALLOWED_SOURCES")
  );
  it("main も一覧が無ければ終了 1", () => {
    try {
      execFileSync(process.execPath, ["hl7-receiver/main.ts"], {
        env: { ...process.env, HL7_ALLOWED_SOURCES: "" },
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const result = error as {
        code?: string;
        status?: number;
        stderr?: Buffer;
      };
      if (result.code === "EPERM") {
        throw error;
      }
      expect(result.status).toBe(1);
      expect(result.stderr?.toString()).toContain("HL7_ALLOWED_SOURCES");
      return;
    }
    throw new Error("一覧が空でも起動した");
  });
  it("一覧に無い住所の 10 接続は閉じ、refused は 1 回", async () => {
    const test = await setup({ allowedSources: ["192.0.2.1"] });
    for (let i = 0;i < 10;i++) {
      const c = await test.open();
      await wait(() => c.socket.destroyed);
      expect(c.data()).toBe("");
    }
    await wait(() => test.bodies.length > 0);
    expect(test.bodies).toEqual([{ peer: "127.0.0.1", event: "refused" }]);
  });
  it("大きすぎる本文は ACK を返さず閉じ、本文を渡さない", async () => {
    const test = await setup({ maxMessageBytes: 8 });
    const c = await test.open();
    c.socket.write("\x0b123456789");
    await wait(() => c.socket.destroyed);
    await wait(() => test.bodies.length > 0);
    expect(c.data()).toBe("");
    expect(test.bodies).toEqual([{ peer: "127.0.0.1", event: "oversize" }]);
  });
  it("1 通を読み終える時間の上限は、バイトが来ても延びない", async () => {
    const test = await setup({ readTimeoutMs: 70 });
    const c = await test.open();
    c.socket.write("\x0b");
    const timer = setInterval(() => c.socket.write("a"), 10);
    try {
      await wait(() => c.socket.destroyed);
    } finally {
      clearInterval(timer);
    }
    await wait(() => test.bodies.length > 0);
    expect(test.bodies[0]?.event).toBe("timeout");
    expect(c.data()).toBe("");
  });
  it.each(["x", "\x0ba\x1cx", "\x0b\x0b"])("枠の誤りは閉じる %s", async (bytes) => {
    const test = await setup();
    const c = await test.open();
    c.socket.write(bytes);
    await wait(() => c.socket.destroyed);
    await wait(() => test.bodies.length > 0);
    expect(test.bodies[0]?.event).toBe("framing");
    expect(c.data()).toBe("");
  });
  it("同時の接続の上限を超えたらすぐ閉じる", async () => {
    const test = await setup({ maxConnections: 1 });
    const a = await test.open();
    const b = await test.open();
    await wait(() => b.socket.destroyed);
    expect(a.socket.destroyed).toBe(false);
    expect(test.bodies).toEqual([]);
  });
  it("分かれた枠と、同じ接続の複数の本文を順に答える", async () => {
    const test = await setup();
    const c = await test.open();
    c.socket.write("\x0bfirst\x1c");
    c.socket.write("\r\x0bsecond\x1c\r");
    await wait(() => c.data().includes("ACK2\x1c\r"));
    expect(c.data()).toBe("\x0bACK1\x1c\r\x0bACK2\x1c\r");
    expect(test.bodies.map((b) => Buffer.from(b.message!, "base64").toString())).toEqual(["first", "second"]);
    expect(test.auth).toEqual(["Bearer synthetic-token", "Bearer synthetic-token"]);
    expect(test.logs.join("")).not.toMatch(/first|second|synthetic-token/);
  });
  it.each(["error", "bad", "timeout", "redirect"] as const)("BFF の失敗 %s で ACK を返さず閉じる", async (mode) => {
    const test = await setup({}, mode);
    const c = await test.open();
    c.socket.write("\x0bbody\x1c\r");
    await wait(() => c.socket.destroyed);
    expect(c.data()).toBe("");
    expect(test.bodies).toHaveLength(1);
  });
});

describe("住所の許可の一覧", () => {
  it.each([
    ["127.0.0.1", ["127.0.0.1"], true],
    ["::ffff:127.0.0.1", ["127.0.0.0/8"], true],
    ["::ffff:127.0.0.1", ["127.0.0.1"], true],
    ["192.0.2.5", ["192.0.2.0/24"], true],
    ["192.0.3.5", ["192.0.2.0/24"], false],
    ["2001:db8::1", ["2001:db8::/32"], true],
    ["2001:db9::1", ["2001:db8::/32"], false],
    ["::1", ["0:0:0:0:0:0:0:1"], true],
    ["::ffff:c000:201", ["192.0.2.0/24"], true],
    ["192.0.2.1", ["::ffff:192.0.2.0/120"], true],
  ] as [
    string,
    string[],
    boolean
  ][])("%s と %j", async (peer, sources, result) => expect(await matchesAllowlist(peer, sources)).toBe(result));
  it("名前は接続ごとに引き直す", async () => {
    let count = 0;
    const resolve = async () => [{ address: count++ === 0 ? "192.0.2.1" : "192.0.2.2" }];
    expect(await matchesAllowlist("192.0.2.1", ["pacs.example.org"], resolve)).toBe(true);
    expect(await matchesAllowlist("192.0.2.1", ["pacs.example.org"], resolve)).toBe(false);
  });
  it(
    "名前の時間切れは通さない",
    async () => expect(await matchesAllowlist("192.0.2.1", ["pacs.example.org"], () => new Promise(() => undefined), 10)).toBe(false)
  );
  it("mapped の住所をそろえる", () => expect(normalizeAddress("::ffff:192.0.2.1")).toBe("192.0.2.1"));
});
it.each(["192.0.2.0/33", "::/129", "bad/name", "bad_name", "999.1.1.1"])("読めない許可の項目 %s は起動を断る", source => expect(() => createReceiver({
  allowedSources: [source],
  forwardUrl: "http://localhost",
  token: "synthetic"
})).toThrow("HL7_ALLOWED_SOURCES"));

it("接続と前の ACK から枠を待つ時間にも上限", async () => {
  const test = await setup({ readTimeoutMs: 40 });
  const idle = await test.open();
  await wait(() => idle.socket.destroyed);
  const next = await test.open();
  next.socket.write("\x0bbody\x1c\r");
  await wait(() => next.data().includes("ACK1"));
  await wait(() => next.socket.destroyed);
  await wait(() => test.bodies.filter(b => b.event === "timeout").length === 2);
});

it("接続待ちの後の枠は新しい期限を持つ", async () => {
  const test = await setup({ readTimeoutMs: 100 });
  const c = await test.open();
  await new Promise(r => setTimeout(r, 60));
  c.socket.write("\x0b");
  await new Promise(r => setTimeout(r, 60));
  c.socket.write("body\x1c\r");
  await wait(() => c.data().includes("ACK1"));
});

it("busy は期間と数を添えてまとめる", async () => {
  const test = await setup({ maxConnections: 1, aggregationMs: 50, readTimeoutMs: 500 });
  await test.open();
  for (let i = 0;i < 3;i++) {
    const c = await test.open();
    await wait(() => c.socket.destroyed);
  }
  await wait(() => test.bodies.some(b => b.event === "busy"));
  expect(test.bodies.filter(b => b.event === "busy")).toMatchObject(
    [{ count: 3, since: expect.any(String), until: expect.any(String) }]
  );
});

it("BFF を待つ間は socket の読み取りを止める", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  let called = false;
  const bff = createServer(async (req, res) => {
    for await (const chunk of req)
      void chunk;
    called = true;
    await gate;
    res.end(JSON.stringify({ ack: Buffer.from("ACK").toString("base64") }));
  });
  const bffPort = await listen(bff);
  const receiver = createReceiver({
    allowedSources: ["127.0.0.1"],
    forwardUrl: `http://127.0.0.1:${bffPort}`,
    token: "synthetic",
    readTimeoutMs: 200,
    forwardTimeoutMs: 500,
    log: () => {
    }
  });
  let accepted: Socket | undefined;
  receiver.on("connection", socket => {
    accepted = socket;
  });
  const port = await listen(receiver);
  const socket = connect(port, "127.0.0.1");
  sockets.push(socket);
  socket.on("error", () => {
  });
  const chunks: Buffer[] = [];
  socket.on("data", b => chunks.push(b));
  await new Promise<void>(r => socket.once("connect", r));
  socket.write("\x0bbody\x1c\r");
  try {
    await wait(() => called);
    expect(accepted?.isPaused()).toBe(true);
  } finally {
    release();
  }
  await wait(() => Buffer.concat(chunks).includes(Buffer.from("ACK")));
  expect(accepted?.isPaused()).toBe(false);
});

it("枠の始まりだけで止まった送り手を時間切れで閉じる", async () => {
  const test = await setup({ readTimeoutMs: 70 });
  const connection = await test.open();
  connection.socket.write("\x0b");
  await wait(() => connection.socket.destroyed);
  await wait(() => test.bodies.some(body => body.event === "timeout"));
  expect(connection.data()).toBe("");
  expect(test.bodies).toEqual([{ peer: "127.0.0.1", event: "timeout" }]);
});
