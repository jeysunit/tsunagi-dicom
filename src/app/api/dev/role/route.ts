import { cookies } from "next/headers";
import { encodeDevRole, DEV_ROLE_COOKIE } from "@/lib/auth/dev-role-cookie";
import { isRole } from "@/lib/auth/roles";
import { audit, getSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";

// 検証モード（AUTH_MODE=dev）の役割の切り替え。画像サーバーへの書き込みではないので、書き込みの止めの外。
// 切り替えも監査の記録に残す（docs/spec.md の 4）。
export async function POST(request: Request) {
  const config = getConfig();
  if (config.auth.mode !== "dev") return Response.json({ error: "検証モードではない" }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { role?: unknown } | null;
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
