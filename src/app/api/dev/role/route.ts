import { cookies } from "next/headers";
import { readLimitedText } from "@/lib/api/body";
import { encodeDevRole, DEV_ROLE_COOKIE } from "@/lib/auth/dev-role-cookie";
import { isRole } from "@/lib/auth/roles";
import { audit, getSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

/** 本文は `{"role":"technologist"}` ほどなので、それより十分に大きいところで切る */
const MAX_BODY_BYTES = 1024;

// 検証モード（AUTH_MODE=dev）の役割の切り替え。画像サーバーへの書き込みではない。
// 切り替えも監査の記録に残す（docs/spec.md の 4）。
export async function POST(request: Request) {
  const config = getConfig();
  if (config.auth.mode !== "dev") return Response.json({ error: "検証モードではない" }, { status: 404 });

  const text = await readLimitedText(request, MAX_BODY_BYTES);
  if (text === null) return Response.json({ error: "本文が大きすぎる" }, { status: 413 });
  let body: { role?: unknown } | null = null;
  try {
    body = JSON.parse(text) as { role?: unknown } | null;
  } catch {
    body = null;
  }
  const to = body?.role;
  if (!isRole(to)) return Response.json({ error: "役割は admin・doctor・technologist・viewer のどれか" }, { status: 400 });

  const session = await getSession();
  await audit(session, { action: "role_switch", detail: { from: session.role, to } });

  const jar = await cookies();
  jar.set(DEV_ROLE_COOKIE, encodeDevRole(to, config.sessionSecret), {
    httpOnly: true,
    sameSite: "strict",
    secure: request.url.startsWith("https:"),
    path: "/",
  });
  return Response.json({ role: to });
}
