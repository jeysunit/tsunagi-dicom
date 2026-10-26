import { errorResponse } from "@/lib/api/respond";
import { requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getConfig } from "@/lib/config";
import { connectionRecord, connectionView } from "@/lib/connection-status";
import { getDb } from "@/lib/db";
import { allowlistFor } from "@/lib/fields";

// 上の帯の接続の状態（docs/spec.md の 3.3）。画像サーバー・HL7 の受け口・接続先の直近の接続確認を返す。
// 読むだけで、機器に C-ECHO を送らない（確かめは接続先の頁の「接続確認」）。患者の情報を含まないので、成功した読み取りは
// 監査の記録に残さない（帯が定期に読むため）。権限の無い要求は断り、断ったことを記録する。
// 返す項目は役割の許可の一覧（connection・modality）で絞る。

export async function GET() {
  try {
    const session = await requireSession();
    await requirePermission(session, "connection.view", { action: "echo", detail: { via: "connection-status" } });
    const record = await connectionRecord({
      backend: getBackend(),
      db: await getDb(),
      hl7Configured: getConfig().hl7ReceiverToken !== undefined,
    });
    return Response.json({ connection: connectionView(record, allowlistFor(session.role)) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
