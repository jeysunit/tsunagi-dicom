import { errorResponse } from "@/lib/api/respond";
import { verifyAuditChain } from "@/lib/audit";
import { AuditAnchorFileError, readAuditAnchors } from "@/lib/audit-anchor";
import { AuthError, requireSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";

// 監査の記録のつなぎを確かめる。管理者だけ（監査の検索と CSV は段 4）。
// AUDIT_ANCHOR_FILE があれば、そこに書き出した先頭の控えとも照らし合わせる（docs/adr/0001-audit-chain-mac.md）
export async function GET() {
  try {
    await requireSession("audit.verify");
    const file = getConfig().audit.anchorFile;
    let anchors;
    try {
      anchors = file ? await readAuditAnchors(file) : [];
    } catch (error) {
      if (error instanceof AuditAnchorFileError) {
        return Response.json({ ok: false, checked: 0, seq: 0, reason: error.message }, { status: 409 });
      }
      throw error;
    }
    // 控えのファイルを設定しているのに、控えが1つも無ければ（消えた・別のファイル）、照らさずに通さない
    const result = await verifyAuditChain(await getDb(), 1000, { anchors, requireAnchors: !!file });
    return Response.json(result, { status: result.ok ? 200 : 409 });
  } catch (error) {
    if (error instanceof AuthError && error.status === 403) {
      return Response.json({ error: "管理者だけが使える" }, { status: 403 });
    }
    return errorResponse(error);
  }
}
