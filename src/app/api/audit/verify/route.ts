import { errorResponse } from "@/lib/api/respond";
import { verifyAuditChain } from "@/lib/audit";
import { AuditAnchorFileError, readAuditAnchors } from "@/lib/audit-anchor";
import { AuthError, requireSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";

// 監査の記録のつなぎを確かめる。管理者だけ（監査の検索と CSV は段 4）。
// AUDIT_ANCHOR_FILE に書き出した先頭の控えと照らし合わせる（docs/adr/0001-audit-chain-mac.md）。
// 照らせないとき（控えのファイルを設定していない・読めない・無い・壊れている）は、つなぎの中に食い違いが無くても
// ok にしない（409）。照らさずに通すと、末尾の削除と、鍵の無い形への作り直しを見落とすため
export async function GET() {
  try {
    await requireSession("audit.verify");
    const db = await getDb();
    const file = getConfig().audit.anchorFile;
    let anchors;
    try {
      anchors = file ? await readAuditAnchors(file) : undefined;
    } catch (error) {
      if (error instanceof AuditAnchorFileError) {
        return Response.json({ ok: false, checked: 0, seq: 0, reason: error.message }, { status: 409 });
      }
      throw error;
    }
    const result = await verifyAuditChain(db, 1000, file ? { anchors, requireAnchors: true } : {});
    if (!result.ok) return Response.json(result, { status: 409 });
    // 行が1つも無いのに利用者がいれば（利用者を作ると記録が残るので）、記録を消されたとみなす。
    // 控えのファイルも一緒に消されると（または控えを設定していないと）、初めての起動と見分けられないため
    if (result.checked === 0 && (await db.user.count()) > 0) {
      return Response.json(
        { ok: false, checked: 0, seq: 1, reason: "利用者がいるのに、監査の記録が1行も無い（消された）" },
        { status: 409 },
      );
    }
    if (result.anchors.status === "not-configured") {
      return Response.json(
        {
          ok: false,
          checked: result.checked,
          seq: 0,
          reason: "AUDIT_ANCHOR_FILE を設定していないので、先頭の控えと照らせない（つなぎの中に食い違いは無い。末尾の削除と作り直しは確かめていない）",
          anchors: result.anchors,
        },
        { status: 409 },
      );
    }
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof AuthError && error.status === 403) {
      return Response.json({ error: "管理者だけが使える" }, { status: 403 });
    }
    return errorResponse(error);
  }
}
