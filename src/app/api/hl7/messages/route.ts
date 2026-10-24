import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { getConfig } from "@/lib/config";
import { readLimitedText } from "@/lib/api/body";
import { errorResponse } from "@/lib/api/respond";
import { enqueue, processMessage, recordReceiverEvent, QueueFull } from "@/lib/hl7/apply";
import { visible } from "../../../../../hl7-receiver/visible";
export const runtime = "nodejs";
const peer = z.string().min(1).max(64).refine((s) => isIP(s) !== 0).refine((s) => visible(s) === s);
const schema = z.union([
  z.object({
    peer,
    message: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  }).strict(),
  z.object({
    peer,
    event: z.enum(["refused", "oversize", "timeout", "framing"])
  }).strict(),
  z.object({
    peer: z.string().refine(s => isIP(s) !== 0 || s === "hl7-receiver"),
    event: z.enum(["busy", "dropped"]),
    count: z.number().int().min(1).max(1000000),
    since: z.iso.datetime(),
    until: z.iso.datetime()
  }).strict().refine(b => Date.parse(b.since) <= Date.parse(b.until)
    && (b.event === "dropped" ? b.peer === "hl7-receiver" : isIP(b.peer) !== 0)),
]);
const digest = (s: string) => createHash("sha256").update(s).digest();

/** 人のセッションを使わず、受け口の token だけを確かめる（design.md §3）。 */
export async function POST(request: Request): Promise<Response> {
  try {
    const token = getConfig().hl7ReceiverToken;
    if (!token) {
      return Response.json({ error: "見つかりません" }, { status: 404 });
    }
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ") || !timingSafeEqual(digest(authorization.slice(7)), digest(token))) {
      console.warn("HL7 の受け口の認証を断った");
      return Response.json({ error: "認証が必要です" }, { status: 401 });
    }
    const text = await readLimitedText(request, 2 * 1024 * 1024);
    let json: unknown;
    try {
      json = text === null ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    const body = schema.safeParse(json);
    if (!body.success) {
      return Response.json({ error: "本文の形が正しくありません" }, { status: 400 });
    }
    const input = body.data;
    if ("event" in input) {
      await enqueue(() => {
        if ("count" in input) {
          const aggregate = { count: input.count, since: input.since, until: input.until };
          return recordReceiverEvent(input.peer, input.event, undefined, aggregate);
        }
        return recordReceiverEvent(input.peer, input.event);
      });
      return Response.json({ ok: true });
    }
    const decoded = Buffer.from(input.message, "base64");
    if (decoded.length > 1024 * 1024 || decoded.toString("base64") !== input.message) {
      return Response.json({ error: "本文の大きさか base64 が正しくありません" }, { status: 400 });
    }
    const ack = await enqueue(() => processMessage(decoded, input.peer));
    return Response.json({ ack: Buffer.from(ack, "utf8").toString("base64") });
  } catch (error) {
    if (error instanceof QueueFull) {
      return Response.json({ error: "待ちの上限を超えた" }, { status: 503 });
    }
    return errorResponse(error);
  }
}
