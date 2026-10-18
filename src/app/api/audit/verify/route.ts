import { errorResponse } from "@/lib/api/respond";
import { verifyAuditChain } from "@/lib/audit";
import { AuthError, requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";

// 監査の記録のつなぎを確かめる。管理者だけ（監査の検索と CSV は段 4）。
export async function GET() {
  try {
    await requireSession("audit.verify");
    const result = await verifyAuditChain(await getDb());
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    if (error instanceof AuthError && error.status === 403) {
      return Response.json({ error: "管理者だけが使える" }, { status: 403 });
    }
    return errorResponse(error);
  }
}
