import { createHash, timingSafeEqual } from "node:crypto";
import { getConfig } from "@/lib/config";
import { errorResponse } from "@/lib/api/respond";
import { enqueue, QueueFull } from "@/lib/hl7/apply";
import { sweepArrivals } from "@/lib/hl7/sweep";
export const runtime = "nodejs";
const digest = (s: string) => createHash("sha256").update(s).digest();

/**
 * 受け口が定期に呼ぶ、照合の後に届いた画像の書き換え（design.md §15）。`/api/hl7/messages` と同じ token だけで通し、
 * メッセージと同じ列で 1 つずつ処理する。本文は読まない。
 */
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
    await request.body?.cancel();
    const result = await enqueue(() => sweepArrivals());
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof QueueFull) {
      return Response.json({ error: "待ちの上限を超えた" }, { status: 503 });
    }
    return errorResponse(error);
  }
}
