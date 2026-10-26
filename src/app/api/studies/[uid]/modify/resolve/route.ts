import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { auditIf, requirePermission, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getDb } from "@/lib/db";
import { enqueue, QueueFull } from "@/lib/keep-uid-write";
import { isRequestId, requestOutcome, rowsOfRequest } from "@/lib/pacs-ops";
import { checkContent } from "@/lib/study-correction";
import { visible } from "../../../../../../../hl7-receiver/visible";
import { contentUnresolved, requestDetail } from "../shared";

// 結果の分からない・部分反映の中身の訂正を、管理者が手で解く（docs/spec.md の 3.5。段 6）。管理者だけ（pacs.reconcile）。
// 書き換えと同じ列の中で、要求の記録を読み直し（実行中の要求とは重ならない）、Orthanc の仕事がまだ動いていれば解かない。
// 作るはずだった検査（BFF が決めた StudyInstanceUID）を Orthanc で探し直し、管理者が書いた確認内容と一緒に記録に足す
// （作られて値が合えば成功、それ以外は失敗）。Orthanc には書き込みを求めない。
// 属性の訂正の結果不明・部分反映は、HL7 の書き換えと同じ部品の行なので、/api/hl7/resolve で書き換えの ID を名指しして解く。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求ID が正しくありません"),
  /** Orthanc の側（ジョブの一覧・ログなど）で、先の修正がどうなったかを確かめた内容（必須） */
  note: z.string().trim().min(1, "確認内容を入力してください").max(500),
});

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { requestId, note } = await readJson(request, Body, 4096);
    await requirePermission(session, "pacs.reconcile", { action: "modify", studyInstanceUid: uid, detail: { requestId, via: "resolve" } });
    return await enqueue(() => resolve(session, uid, requestId, note));
  } catch (error) {
    if (error instanceof QueueFull) return Response.json({ error: "処理が混み合っています。時間をおいて、やり直してください" }, { status: 503 });
    return errorResponse(error);
  }
}

async function resolve(session: Session, uid: string, requestId: string, note: string): Promise<Response> {
  const db = await getDb();
  const rows = await rowsOfRequest(db, "modify", requestId, uid);
  const d = requestDetail(rows);
  const o = requestOutcome(rows);
  if (o.phase === "none" || d.kind !== "content") {
    return Response.json({ error: "この検査に、その要求ID の検査情報修正はありません" }, { status: 404 });
  }
  if (!contentUnresolved(rows)) return Response.json({ error: "この修正の結果は確定しています" }, { status: 409 });
  const backend = getBackend();
  // Orthanc の仕事がまだ動いていれば（BFF が待ちきれずに結果不明にした後も、Orthanc は写し続けうる）、終わるまで解かない
  if (o.jobId) {
    const job = await backend.jobStatus(o.jobId);
    if (job && job.state !== "Success" && job.state !== "Failure") {
      return Response.json({ error: "この修正のジョブはまだ動いています。終わってから確認してください" }, { status: 409 });
    }
  } else if (await backend.unfinishedModifyJobs() > 0) {
    // 仕事の ID が分からない（Orthanc が受けた後に答えが失われた・記録に失敗した）。この修正の仕事がまだ動いているかもしれない
    return Response.json({ error: "画像サーバーに、終わっていない書き換えのジョブがあります。終わってから確認してください" }, { status: 409 });
  }
  const fields = (d.fields ?? {}) as Record<string, { after?: unknown }>;
  const check = await checkContent(backend, {
    orthancId: String(d.orthancId ?? ""),
    StudyInstanceUID: uid,
    newStudyInstanceUid: String(d.newStudyInstanceUid ?? ""),
    after: Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, String(v?.after ?? "")])),
    instanceCount: Number(d.instanceCount ?? -1),
  });
  const resolved = await auditIf<boolean>(session, async (tx) => {
    const now = await rowsOfRequest(tx, "modify", requestId, uid);
    // 結果不明と部分反映（作られた検査が合わない・元が残っていない）を解く
    if (!contentUnresolved(now)) return { value: false, fields: null };
    return {
      value: true,
      fields: {
        action: "modify",
        outcome: check.matches && check.sourceKept ? "success" : "failed",
        patientId: now.find((r) => r.patientId)?.patientId ?? null,
        studyInstanceUid: uid,
        detail: {
          requestId,
          phase: "reconcile",
          kind: "content",
          manual: true,
          ...check,
          note: visible(note),
          // 書き換えの部品の組も、同じ行で解く（HL7 の受信・見回りの止めが外れる）
          ...(typeof d.writeId === "string" ? { event: "reconcile", writeId: d.writeId } : {}),
        },
      },
    };
  });
  if (!resolved) return Response.json({ error: "この修正の結果は確定しています" }, { status: 409 });
  return Response.json({ requestId, outcome: check.matches && check.sourceKept ? "created" : "failed", ...check });
}
