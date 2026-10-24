import { BlockList, createServer, isIP, type Server, type Socket } from "node:net";
import { lookup } from "node:dns/promises";
import { visible } from "./visible.ts";

/** IPv4 を写した IPv6 も同じ住所として比べる（design.md §12）。 */
export function normalizeAddress(address: string): string {
  const parsed = addressBits(address);
  if (isIP(address) === 6 && parsed?.size === 32) {
    return [24n, 16n, 8n, 0n].map((shift) => String((parsed.bits >> shift) & 255n)).join(".");
  }
  return address.toLowerCase();
}

function addressBits(address: string): {
  bits: bigint;
  size: number;
} | null {
  const value = address.toLowerCase();
  if (isIP(value) === 4) {
    return {
      bits: value.split(".").reduce((n, p) => (n << 8n) | BigInt(p), 0n),
      size: 32
    };
  }
  if (isIP(value) !== 6) {
    return null;
  }
  let hex = value.split("%")[0]!;
  if (hex.includes(".")) {
    const last = hex.lastIndexOf(":");
    const v4 = addressBits(hex.slice(last + 1))!;
    hex = `${hex.slice(0, last)}:${(v4.bits >> 16n).toString(16)}:${(v4.bits & 65535n).toString(16)}`;
  }
  const [left, right] = hex.split("::");
  const a = left ? left.split(":") : [];
  const b = right ? right.split(":") : [];
  const groups = right !== undefined ? [...a, ...Array(8 - a.length - b.length).fill("0"), ...b] : a;
  const bits = groups.reduce((n, p) => (n << 16n) | BigInt(`0x${p}`), 0n);
  return bits >> 32n === 65535n ? { bits: bits & 0xffffffffn, size: 32 } : { bits, size: 128 };
}

export type Resolver = (hostname: string) => Promise<readonly {
  address: string;
}[]>;

function sourceRule(source: string): {
  network: string;
  prefix?: number;
} | null {
  const pieces = source.split("/");
  const network = normalizeAddress(pieces[0]!);
  if (isIP(network)) {
    if (pieces.length > 2) {
      throw new Error("HL7_ALLOWED_SOURCES の CIDR が正しくない");
    }
    const size = isIP(network) === 4 ? 32 : 128;
    let prefix = pieces[1] === undefined ? size : /^\d+$/.test(pieces[1]) ? Number(pieces[1]) : -1;
    if (isIP(pieces[0]!) === 6 && size === 32 && pieces[1] !== undefined) {
      prefix -= 96;
    }
    if (prefix < 0 || prefix > size) {
      throw new Error("HL7_ALLOWED_SOURCES の CIDR が正しくない");
    }
    return { network, prefix };
  }
  const validLabels = source.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (pieces.length !== 1 || source.length > 253 || !validLabels || /^[\d.]+$/.test(source)) {
    throw new Error("HL7_ALLOWED_SOURCES の項目が正しくない");
  }
  return null;
}

/** 接続ごとに名前を引き直し、引けない送り手は通さない（design.md §12）。 */
export async function matchesAllowlist(
  address: string,
  sources: readonly string[],
  resolve: Resolver = name => lookup(name, { all: true }),
  timeoutMs = 2000,
): Promise<boolean> {
  const peer = normalizeAddress(address);
  if (!isIP(peer)) {
    return false;
  }
  const list = new BlockList();
  for (const source of sources) {
    const rule = sourceRule(source);
    if (rule) {
      list.addSubnet(rule.network, rule.prefix!, isIP(rule.network) === 4 ? "ipv4" : "ipv6");
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const records = await Promise.race([
          resolve(source),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("DNS timeout")), timeoutMs);
          })
        ]);
        for (const record of records) {
          const ip = normalizeAddress(record.address);
          if (isIP(ip)) {
            list.addAddress(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
          }
        }
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  return list.check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6");
}

export interface ReceiverOptions {
  allowedSources: readonly string[];
  forwardUrl: string;
  token: string;
  maxMessageBytes?: number;
  readTimeoutMs?: number;
  forwardTimeoutMs?: number;
  maxConnections?: number;
  resolve?: Resolver;
  dnsTimeoutMs?: number;
  log?: (line: string) => void;
  retryDelaysMs?: number[];
  aggregationMs?: number;
}

/** 本文を解析せず、許可した接続の MLLP だけを BFF に渡す（design.md §1・§12）。 */
export function createReceiver(options: ReceiverOptions): Server {
  if (!options.allowedSources.length || options.allowedSources.some((s) => !s.trim())) {
    throw new Error("HL7_ALLOWED_SOURCES は必須");
  }
  options.allowedSources.forEach(sourceRule);
  const maxConnections = options.maxConnections ?? 8;
  const needsLookup = options.allowedSources.some(source => !sourceRule(source));
  let lookups = 0;
  const maxBytes = options.maxMessageBytes ?? 1048576;
  const readMs = options.readTimeoutMs ?? 30000;
  const forwardMs = options.forwardTimeoutMs ?? 60000;
  const log = (event: string, peer: string) => (options.log ?? console.log)(`HL7 ${visible(event)} ${visible(peer)}`);
  const refused = new Map<string, number>();
  const sockets = new Set<Socket>();
  const forward = async (body: object, signal?: AbortSignal): Promise<unknown> => {
    const res = await fetch(options.forwardUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.any([AbortSignal.timeout(forwardMs), ...(signal ? [signal] : [])]),
      redirect: "error"
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error("BFF の応答が誤り");
    }
    return res.json();
  };
  type Dropped = {
    count: number;
    since: string;
    until: string;
  };
  let dropped: Dropped | undefined;
  const restoreDropped = (batch: Dropped) => {
    const pending = dropped;
    dropped = pending ? {
      count: Math.min(1000000, pending.count + batch.count),
      since: batch.since,
      until: pending.until
    } : batch;
  };
  const attempt = async (body: Record<string, unknown>): Promise<boolean> => {
    for (const delay of [0, ...(options.retryDelaysMs ?? [1000, 5000, 30000])]) {
      if (delay) {
        await new Promise<void>(r => {
          const t = setTimeout(r, delay);
          t.unref();
        });
      }
      try {
        await forward(body);
        return true;
      } catch { /* 規定の間隔で送り直す。 */
      }
    }
    return false;
  };
  const recordDropped = () => {
    const now = new Date().toISOString();
    dropped = {
      count: Math.min(1000000, (dropped?.count ?? 0) + 1),
      since: dropped?.since ?? now,
      until: now
    };
  };
  // 知らせを失った数も次の成功時に渡し、監査の抜けを分かるようにする（design.md §10）。
  const deliver = async (body: Record<string, unknown>) => {
    if (await attempt(body)) {
      if (dropped) {
        const batch = dropped;
        dropped = undefined;
        if (!await attempt({ peer: "hl7-receiver", event: "dropped", ...batch })) {
          restoreDropped(batch);
        }
      }
      return;
    }
    recordDropped();
    log("知らせを渡せない", String(body.peer));
  };
  const queue: Record<string, unknown>[] = [];
  let senders = 0;
  const drain = () => {
    while (senders < 2 && queue.length) {
      const body = queue.shift()!;
      senders++;
      void deliver(body).finally(() => {
        senders--;
        drain();
      });
    }
  };
  const enqueue = (body: Record<string, unknown>) => {
    // 再送待ちも含め、知らせは64件まで持つ。
    if (queue.length + senders >= 64) {
      recordDropped();
      return;
    }
    queue.push(body);
    drain();
  };
  const report = (peer: string, event: string) => {
    log(event, peer);
    enqueue({ peer, event });
  };
  let busy: {
    count: number;
    since: string;
    until: string;
    peer: string;
  } | undefined;
  let busyTimer: ReturnType<typeof setTimeout> | undefined;
  const reportBusy = (peer: string) => {
    const now = new Date().toISOString();
    busy = {
      count: Math.min(1000000, (busy?.count ?? 0) + 1),
      since: busy?.since ?? now,
      until: now,
      peer
    };
    busyTimer ??= setTimeout(() => {
      const batch = busy;
      busy = undefined;
      busyTimer = undefined;
      if (batch) {
        enqueue({ event: "busy", ...batch });
      }
    }, options.aggregationMs ?? 60000);
    busyTimer.unref();
  };
  const server = createServer((socket) => {
    socket.on("error", () => log("接続の誤り", socket.remoteAddress ?? ""));
    const peer = normalizeAddress(socket.remoteAddress ?? "");
    if (sockets.size >= maxConnections || (needsLookup && lookups >= maxConnections)) {
      reportBusy(peer);
      socket.destroy();
      return;
    }
    sockets.add(socket);
    // 許可を確かめる前に、本文を読み始めない（design.md §12）。
    socket.pause();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (event: string) => {
      if (!socket.destroyed) {
        report(peer, event);
        socket.destroy();
      }
    };
    const deadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail("timeout"), readMs);
    };
    deadline();
    let closed = false;
    let forwarding: AbortController | undefined;
    socket.on("close", () => {
      closed = true;
      clearTimeout(timer);
      forwarding?.abort();
      if (!forwarding) {
        sockets.delete(socket);
      }
    });
    let state: "start" | "body" | "cr" = "start";
    let parts: number[] = [];
    let pending = Buffer.alloc(0);
    let busy = false;
    const pump = async () => {
      if (busy) {
        return;
      }
      busy = true;
      // BFF を待つ間は次の本文を読み込まず、接続内の順を保つ（design.md §12）。
      socket.pause();
      try {
        while (pending.length && !socket.destroyed) {
          const chunk = pending;
          pending = Buffer.alloc(0);
          for (let i = 0;i < chunk.length;i++) {
            const byte = chunk[i]!;
            if (state === "start") {
              if (byte !== 0x0b) {
                fail("framing");
                return;
              }
              state = "body";
              deadline();
            } else if (state === "body") {
              if (byte === 0x1c) {
                state = "cr";
              } else if (byte === 0x0b) {
                fail("framing");
                return;
              } else {
                parts.push(byte);
                if (parts.length > maxBytes) {
                  fail("oversize");
                  return;
                }
              }
            } else {
              if (byte !== 0x0d) {
                fail("framing");
                return;
              }
              clearTimeout(timer);
              const message = Buffer.from(parts).toString("base64");
              parts = [];
              state = "start";
              forwarding = new AbortController();
              let response: unknown;
              try {
                response = await forward({ peer, message }, forwarding.signal);
              } finally {
                forwarding = undefined;
                if (closed) {
                  sockets.delete(socket);
                }
              }
              const ack = response && typeof response === "object" ? (response as {
                ack?: unknown;
              }).ack : undefined;
              if (typeof ack !== "string" || !ack || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(ack)) {
                throw new Error("ACK の形が誤り");
              }
              const bytes = Buffer.from(ack, "base64");
              if (bytes.length > maxBytes || bytes.includes(0x0b) || bytes.includes(0x1c)) {
                throw new Error("ACK の枠が誤り");
              }
              if (socket.destroyed) {
                return;
              }
              await new Promise<void>((resolve, reject) => {
                const frame = Buffer.concat([Buffer.from([0x0b]), bytes, Buffer.from([0x1c, 0x0d])]);
                const onClose = () => reject(new Error("ACK の途中で接続が閉じた"));
                socket.once("close", onClose);
                deadline();
                socket.write(frame, error => {
                  socket.off("close", onClose);
                  clearTimeout(timer);
                  if (error) {
                    reject(error);
                  } else {
                    resolve();
                  }
                });
              });
              log("ACK", peer);
              deadline();
            }
          }
        }
      } catch {
        log("受け渡しに失敗した", peer);
        socket.destroy();
      } finally {
        busy = false;
        if (!socket.destroyed) {
          socket.resume();
        }
      }
    };
    // FIN の前に枠を読み終えなかった場合も、枠の誤りとして知らせる。
    socket.on("end", () => {
      if (state !== "start") {
        fail("framing");
      }
    });
    const resolve: Resolver = async name => {
      if (lookups >= maxConnections) {
        reportBusy(peer);
        throw new Error("名前の問い合わせの上限");
      }
      lookups++;
      try {
        return await (options.resolve ?? (name => lookup(name, { all: true })))(name);
      } finally {
        // 時間切れでも、問い合わせが終わるまで枠を保つ。
        lookups--;
      }
    };
    void matchesAllowlist(peer, options.allowedSources, resolve, options.dnsTimeoutMs).then((allowed) => {
      if (socket.destroyed) {
        return;
      }
      if (!allowed) {
        const now = Date.now();
        for (const [address, at] of refused)
          if (now - at >= 60000) {
            refused.delete(address);
          }
        if (!refused.has(peer)) {
          refused.set(peer, now);
          report(peer, "refused");
        }
        socket.destroy();
        return;
      }
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        void pump();
      });
      socket.resume();
    }).catch(() => socket.destroy());
  });
  server.on("close", () => {
    clearTimeout(busyTimer);
    if (busy) {
      enqueue({ event: "busy", ...busy });
      busy = undefined;
    }
  });
  return server;
}
