import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { auditIf, requirePermission } from "@/lib/auth/session";
import { isRequestId, requestOutcome, rowsOfRequest } from "@/lib/pacs-ops";

// 結果の分からない送信の照らし合わせ（docs/spec.md の 3.5。段 4）。管理者だけ（pacs.reconcile）。
// Orthanc の仕事の ID も分からない結果不明の送信は、BFF からは確かめられないので、管理者が送り先（受け取る側の記録）で
// 届いたかを確かめ、その結果と確かめた内容を記録に足す（phase は reconcile）。足すまで、同じ検査を同じ送り先へは送れない。
// Orthanc には何も求めない（書き込みの操作ではない）。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求の ID（UUID）の形が誤り"),
  /** 送り先に届いていたか（管理者が確かめた結果） */
  delivered: z.boolean(),
  /** どこで・どう確かめたか（必須） */
  note: z.string().trim().min(1, "確かめた内容を書く").max(500),
});

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { requestId, delivered, note } = await readJson(request, Body, 4096);
    await requirePermission(session, "pacs.reconcile", { action: "send", studyInstanceUid: uid, detail: { requestId, via: "resolve" } });
    const result = await auditIf(session, async (tx) => {
      const rows = await rowsOfRequest(tx, "send", requestId);
      const o = requestOutcome(rows);
      if (o.phase === "none" || o.studyInstanceUid !== uid) return { value: "missing" as const, fields: null };
      if (!(o.phase === "requested" || (o.phase === "result" && o.outcome === "unknown"))) {
        return { value: "settled" as const, fields: null };
      }
      return {
        value: "resolved" as const,
        fields: {
          action: "send",
          outcome: delivered ? "success" : "failed",
          patientId: rows.find((r) => r.patientId)?.patientId ?? null,
          studyInstanceUid: uid,
          detail: { requestId, modality: o.modality, phase: "reconcile", manual: true, delivered, note },
        },
      };
    });
    if (result === "missing") return Response.json({ error: "この検査の、その要求の ID の送信が無い" }, { status: 404 });
    if (result === "settled") return Response.json({ error: "この送信の結果は、もう分かっている" }, { status: 409 });
    return Response.json({ requestId, outcome: delivered ? "delivered" : "not_delivered" });
  } catch (error) {
    return errorResponse(error);
  }
}
