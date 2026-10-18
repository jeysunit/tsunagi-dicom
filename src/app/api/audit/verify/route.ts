import { verifyAuditChain } from "@/lib/audit";
import { getSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

// 監査の記録のつなぎを確かめる。管理者だけ（監査の検索と CSV は段 4）。
export async function GET() {
  const session = await getSession();
  if (session.role !== "admin") return Response.json({ error: "管理者だけが使える" }, { status: 403 });
  const result = await verifyAuditChain(await getDb());
  return Response.json(result, { status: result.ok ? 200 : 409 });
}
