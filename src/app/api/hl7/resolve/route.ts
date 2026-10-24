import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { auditIf, requirePermission } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { enqueue, history, unresolved, verify } from "@/lib/hl7/apply";
import { visible } from "../../../../../hl7-receiver/visible";
const Body = z.object({ writeId: z.uuid(), note: z.string().trim().min(1).max(500) }).strict();

/** 管理者の確認内容と全画像の読み直しを記録する。書き換えは呼ばない（design.md §10）。 */
export async function POST(request: Request) {
  try {
    const session = await checkedScreenWrite(request);
    const { writeId, note } = await readJson(request, Body, 4096);
    await requirePermission(session, "pacs.reconcile", { action: "hl7", detail: { writeId, via: "resolve" } });
    return await enqueue(async () => {
      const rows = await history();
      const d = unresolved(rows).find(d => d.writeId === writeId);
      if (!d) {
        return Response.json({ error: "この書き換えは無いか、結果が確定しています" }, { status: 409 });
      }
      const checked = await verify(getBackend(), d);
      await auditIf(session, async () => ({
        value: true,
        fields: {
          action: "hl7",
          outcome: checked.matchesAfter ? "success" : "failed",
          patientId: d.after[0]?.PatientID,
          studyInstanceUid: d.StudyInstanceUID,
          detail: {
            event: "reconcile",
            writeId,
            manual: true,
            ...checked,
            note: visible(note)
          }
        }
      }));
      return Response.json({ writeId, ...checked });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
