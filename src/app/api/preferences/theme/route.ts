import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { getDb } from "@/lib/db";
import { setTheme, THEMES } from "@/lib/preferences";

// 地の色（明るい地・暗い地）を、利用者ごとに覚える（docs/spec.md の 2）。画像サーバーには書かない。

const Body = z.object({ theme: z.enum(THEMES) });

export async function POST(request: Request) {
  try {
    const session = await checkedScreenWrite(request);
    const { theme } = await readJson(request, Body, 256);
    await setTheme(await getDb(), session.actorId, theme);
    return Response.json({ theme });
  } catch (error) {
    return errorResponse(error);
  }
}
