// MLLP の受け口。Node.js 24 の型の除去で、そのまま動かす。
import { readFileSync } from "node:fs";
import { createReceiver } from "./receiver.ts";
import { startSweeper } from "./sweep.ts";
import { visible } from "./visible.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`${name} は必須`);
  }
  return value;
}

function integer(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const value = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) {
    throw new Error(`${name} は正の整数にする`);
  }
  return Number(value);
}
try {
  const allowedSources = required("HL7_ALLOWED_SOURCES").split(/[\s,]+/).filter(Boolean);
  if (!allowedSources.length) {
    throw new Error("HL7_ALLOWED_SOURCES は必須");
  }
  const forwardUrl = required("HL7_FORWARD_URL");
  const url = new URL(forwardUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("HL7_FORWARD_URL の形が違う");
  }
  let token: string;
  try {
    token = readFileSync(required("HL7_RECEIVER_TOKEN_FILE"), "utf8").replace(/\r?\n$/, "");
  } catch {
    throw new Error("HL7_RECEIVER_TOKEN_FILE を読めない");
  }
  if ([...token].length < 32) {
    throw new Error("HL7_RECEIVER_TOKEN_FILE は 32 文字以上にする");
  }
  const server = createReceiver({
    allowedSources,
    forwardUrl,
    token,
    maxMessageBytes: integer("HL7_MAX_MESSAGE_BYTES", 1048576, 1048576),
    readTimeoutMs: integer("HL7_READ_TIMEOUT_SECONDS", 30) * 1000,
    forwardTimeoutMs: integer("HL7_FORWARD_TIMEOUT_SECONDS", 60) * 1000,
    maxConnections: integer("HL7_MAX_CONNECTIONS", 8, 8),
  });
  server.on("error", () => {
    console.error("HL7 の待ち受けに失敗した");
    process.exitCode = 1;
  });
  // 照合の後に届いた画像の書き換えを頼む先。既定は HL7_FORWARD_URL と同じ場所の sweep（/api/hl7/sweep）
  const sweepUrl = new URL(process.env.HL7_SWEEP_URL ?? "sweep", forwardUrl);
  if (!["http:", "https:"].includes(sweepUrl.protocol) || sweepUrl.username || sweepUrl.password) {
    throw new Error("HL7_SWEEP_URL の形が違う");
  }
  const stopSweeper = startSweeper({
    url: sweepUrl.href,
    token,
    intervalMs: integer("HL7_SWEEP_INTERVAL_SECONDS", 60, 86400) * 1000,
    timeoutMs: integer("HL7_FORWARD_TIMEOUT_SECONDS", 60) * 1000,
  });
  server.listen(integer("HL7_LISTEN_PORT", 2575, 65535), process.env.HL7_LISTEN_HOST ?? "0.0.0.0");
  process.on("SIGTERM", () => {
    stopSweeper();
    server.close();
  });
} catch (error) {
  console.error(visible(error instanceof Error ? error.message : "HL7 の起動に失敗した"));
  process.exitCode = 1;
}
