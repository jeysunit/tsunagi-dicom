import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, ConfigError, type AppConfig } from "@/lib/config";
const state = vi.hoisted(() => ({
  config: undefined as AppConfig | undefined,
  process: vi.fn(),
  event: vi.fn()
}));
vi.mock("@/lib/config", async (original) => ({
  ...await original<typeof import("@/lib/config")>(),
  getConfig: () => state.config!
}));
vi.mock("@/lib/hl7/apply", async (original) => ({
  ...await original<typeof import("@/lib/hl7/apply")>(),
  processMessage: state.process,
  recordReceiverEvent: state.event
}));
import { POST } from "@/app/api/hl7/messages/route";
const token = randomBytes(32).toString("hex");
const base = {
  BACKEND_MOCK: "true",
  AUTH_MODE: "dev",
  SESSION_SECRET: "x".repeat(48)
};
const req = (
  body: unknown = { peer: "192.0.2.1", message: "TVNI" },
  authorization: string | null = `Bearer ${token}`,
) => new Request("http://localhost/api/hl7/messages", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    ...(authorization === null ? {} : { authorization }),
    cookie: "session=admin"
  },
  body: JSON.stringify(body)
});
beforeEach(() => {
  vi.clearAllMocks();
  state.config = { ...loadConfig(base), hl7ReceiverToken: token };
  state.process.mockResolvedValue("MSA|AA|ID|ok\r");
  state.event.mockResolvedValue(undefined);
});

describe("HL7 の API と設定", () => {
  it("設定が無ければ 404", async () => {
    delete state.config!.hl7ReceiverToken;
    expect((await POST(req())).status).toBe(404);
    expect(state.process).not.toHaveBeenCalled();
  });
  it.each([null, "Bearer wrong", "Basic value"])("token が違えば、セッションがあっても 401", async (auth) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect((await POST(req(undefined, auth))).status).toBe(401);
      expect(state.process).not.toHaveBeenCalled();
      expect(state.event).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.flat().join("")).not.toContain(token);
    } finally {
      warn.mockRestore();
    }
  });
  it("ACK を base64 にして返す", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ack: Buffer.from("MSA|AA|ID|ok\r").toString("base64") });
    expect(state.process).toHaveBeenCalledWith(Buffer.from("MSH"), "192.0.2.1");
  });
  it("空の本文も解析へ渡し、HL7 の AR を作れるようにする", async () => {
    expect((await POST(req({ peer: "192.0.2.1", message: "" }))).status).toBe(200);
    expect(state.process).toHaveBeenCalledWith(Buffer.alloc(0), "192.0.2.1");
  });
  it("並んで来た要求も 1 通ずつ処理する", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    state.process.mockImplementationOnce(async () => {
      await gate;
      return "ACK1";
    }).mockResolvedValueOnce("ACK2");
    const a = POST(req());
    const b = POST(req());
    await vi.waitFor(() => expect(state.process).toHaveBeenCalledTimes(1));
    release();
    const responses = await Promise.all([a, b]);
    expect(await responses[0]!.json()).toEqual({ ack: Buffer.from("ACK1").toString("base64") });
    expect(await responses[1]!.json()).toEqual({ ack: Buffer.from("ACK2").toString("base64") });
  });
  it.each(["refused", "oversize", "timeout", "framing"])("%s の知らせ", async (event) => {
    expect(await (await POST(req({ peer: "2001:db8::1", event }))).json()).toEqual({ ok: true });
    expect(state.event).toHaveBeenCalledWith("2001:db8::1", event);
  });
  it.each([
    {},
    { peer: "x", message: "TVNI" },
    { peer: "1".repeat(65), message: "TVNI" },
    { peer: "192.0.2.1\n", message: "TVNI" },
    { peer: "192.0.2.1", message: "%%%" },
    { peer: "192.0.2.1", event: "other" },
    { peer: "192.0.2.1", event: "refused", message: "TVNI" }
  ])("形の誤りは 400", async (body) => {
    expect((await POST(req(body))).status).toBe(400);
    expect(state.process).not.toHaveBeenCalled();
  });
  it(
    "2 MiB を超える本文は 400",
    async () => expect((await POST(req({ peer: "192.0.2.1", message: "A".repeat(2 * 1024 * 1024) }))).status).toBe(400)
  );
  it("JSON の誤りは 400", async () => {
    const request = new Request("http://localhost/api/hl7/messages", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{"
    });
    expect((await POST(request)).status).toBe(400);
  });
  it("ファイルの末尾の改行を落として token を読む", () => expect(loadConfig({
    ...base,
    HL7_RECEIVER_TOKEN_FILE: "/synthetic",
    HL7_PATIENT_ID_ISSUER: "RIS_EMU"
  }, { readFile: () => `${token}\n` }).hl7ReceiverToken).toBe(token));
  it.each(["", "x".repeat(31)])("短い token を ConfigError にする", (text) => expect(() => loadConfig({
    ...base,
    HL7_RECEIVER_TOKEN_FILE: "/synthetic",
    HL7_PATIENT_ID_ISSUER: "RIS_EMU"
  }, { readFile: () => text })).toThrow(ConfigError));
  it("token のファイルを読めなければ ConfigError", () => expect(() => loadConfig({
    ...base,
    HL7_RECEIVER_TOKEN_FILE: "/synthetic",
    HL7_PATIENT_ID_ISSUER: "RIS_EMU"
  }, {
    readFile: () => {
      throw new Error("ENOENT");
    }
  })).toThrow(ConfigError));
});
it.each([
  { HL7_RECEIVER_TOKEN_FILE: "/synthetic" },
  { HL7_PATIENT_ID_ISSUER: "RIS_EMU" }
])("片方だけの設定は ConfigError", setting => expect(() => loadConfig({ ...base, ...setting }, { readFile: () => token })).toThrow(ConfigError));
it.each(["busy", "dropped"])("%s のまとめた数と期間を記録する", async (event) => {
  const body = {
    peer: event === "dropped" ? "hl7-receiver" : "192.0.2.1",
    event,
    count: 3,
    since: "2026-10-24T00:00:00Z",
    until: "2026-10-24T00:01:00Z"
  };
  expect((await POST(req(body))).status).toBe(200);
  expect(state.event).toHaveBeenCalledWith(body.peer, event, undefined, { count: 3, since: body.since, until: body.until });
  expect((await POST(req({ ...body, count: undefined }))).status).toBe(400);
  expect((await POST(req({ ...body, count: 0 }))).status).toBe(400);
});

it("復号が1 MiBを超えると400", async () => expect((await POST(req({
  peer: "192.0.2.1",
  message: Buffer.alloc(1048577).toString("base64")
}))).status).toBe(400));

it("base64 の未使用ビットも厳密に確かめる", async () => expect((await POST(req({ peer: "192.0.2.1", message: "TR==" }))).status).toBe(400));

it("偽った content-length でも読んだ本文が2 MiBを超えれば400", async () => {
  const request = new Request("http://localhost/api/hl7/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-length": "1" },
    body: " ".repeat(2 * 1024 * 1024 + 1)
  });
  expect((await POST(request)).status).toBe(400);
});

it("16通の待ちを超えると503", async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => {
    release = r;
  });
  state.process.mockImplementation(async () => {
    await gate;
    return "ACK";
  });
  const active = POST(req());
  await vi.waitFor(() => expect(state.process).toHaveBeenCalledTimes(1));
  const pending = Array.from({ length: 16 }, () => POST(req()));
  await new Promise(r => setTimeout(r, 10));
  try {
    expect((await POST(req())).status).toBe(503);
  } finally {
    release();
    await Promise.all([active, ...pending]);
  }
});
