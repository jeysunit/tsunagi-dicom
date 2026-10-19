import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { auditIf, requirePermission } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getDb } from "@/lib/db";
import { deletedStudyStillPresent, isRequestId, requestOutcome, rowsOfRequest } from "@/lib/pacs-ops";

// 結果の分からない削除を、管理者が手で解く（docs/spec.md の 3.5。段 5）。管理者だけ（pacs.reconcile）。
// 検査が Orthanc にまだあるだけでは、先の DELETE が止まった・終わったとは言えない（遅れて消えることがある）ので、
// BFF は自動では「消えていない」と確定させない。管理者が Orthanc の側（ログ・再起動の有無・仕事の一覧など）で
// 先の削除の処理が終わっていることを確かめ、その内容を書いて解く。解くまで、同じ検査の新しい削除は断る。
// 解くときに Orthanc をもう一度読み、検査が無ければ「消えた」、まだあれば「消えていない」として記録に足す（phase は reconcile）。
// Orthanc には書き込みを求めない。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求の ID（UUID）の形が誤り"),
  /** 先の削除の処理が終わっていることを、どこで・どう確かめたか（必須） */
  note: z.string().trim().min(1, "確かめた内容を書く").max(500),
});

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { requestId, note } = await readJson(request, Body, 4096);
    await requirePermission(session, "pacs.reconcile", { action: "delete", studyInstanceUid: uid, detail: { requestId, via: "resolve" } });
    const db = await getDb();
    const before = await rowsOfRequest(db, "delete", requestId);
    const o = requestOutcome(before);
    if (o.phase === "none" || o.studyInstanceUid !== uid) return Response.json({ error: "この検査の、その要求の ID の削除が無い" }, { status: 404 });
    const still = await deletedStudyStillPresent(getBackend(), before, uid);
    const result = await auditIf(session, async (tx) => {
      const rows = await rowsOfRequest(tx, "delete", requestId);
      const now = requestOutcome(rows);
      if (!(now.phase === "requested" || (now.phase === "result" && now.outcome === "unknown"))) {
        return { value: "settled" as const, fields: null };
      }
      return {
        value: "resolved" as const,
        fields: {
          action: "delete",
          outcome: still ? "failed" : "success",
          patientId: rows.find((r) => r.patientId)?.patientId ?? null,
          studyInstanceUid: uid,
          detail: { requestId, phase: "reconcile", manual: true, studyPresent: still, note },
        },
      };
    });
    if (result === "settled") return Response.json({ error: "この削除の結果は、もう分かっている" }, { status: 409 });
    return Response.json({ requestId, outcome: still ? "not_deleted" : "deleted" });
  } catch (error) {
    return errorResponse(error);
  }
}
