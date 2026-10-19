import { errorResponse } from "@/lib/api/respond";
import { auditIf, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { jobFinished } from "@/lib/backend/orthanc-rest";
import { getConfig } from "@/lib/config";
import { openJobToken, requestOutcome, rowsOfRequest } from "@/lib/pacs-ops";

// 送った仕事（Orthanc の job）の状態（docs/spec.md の 3.4）。画面は、送ったときに受けた暗号化した token で読む。
// 書き換えた token・期限の過ぎた token・ほかの利用者の token は 404（仕事の ID を替えて、ほかの仕事を覗けないように）。
// 返すのは状態・進み・誤りの番号と文言・始めと終わりの時刻だけ（仕事の中身は返さない）。
// 仕事の終わり（成功・失敗）を初めて読んだときに、監査の記録（send の done）に残す（記録の並びの中で確かめて、1行だけ）。

type Context = { params: Promise<{ token: string }> };

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

export async function GET(_request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const payload = openJobToken(decoded((await params).token), getConfig().sessionSecret);
    await requirePermission(session, "study.send", {
      action: "send",
      studyInstanceUid: payload?.studyInstanceUid ?? null,
      detail: { via: "job_status", ...(payload ? { requestId: payload.requestId } : {}) },
    });
    if (!payload || payload.actorId !== session.actorId) {
      return Response.json({ error: "この仕事は読めない" }, { status: 404 });
    }
    const job = await getBackend().jobStatus(payload.jobId);
    if (!job) return Response.json({ error: "仕事が見つからない（Orthanc の仕事の記録から消えたことがある）" }, { status: 404 });

    if (jobFinished(job.state)) {
      await auditIf(session, async (tx) => {
        const rows = await rowsOfRequest(tx, "send", payload.requestId, payload.studyInstanceUid);
        if (requestOutcome(rows).phase === "done") return { value: null, fields: null };
        return {
          value: null,
          fields: {
            action: "send",
            outcome: job.state === "Success" ? "success" : "failed",
            studyInstanceUid: payload.studyInstanceUid,
            patientId: rows.find((r) => r.patientId)?.patientId ?? null,
            detail: {
              phase: "done",
              requestId: payload.requestId,
              modality: payload.modality,
              jobId: job.id,
              state: job.state,
              ...(job.state === "Failure" ? { errorCode: job.errorCode } : {}),
            },
          },
        };
      });
    }
    return Response.json({
      state: job.state,
      progress: job.progress,
      errorCode: job.errorCode,
      errorDescription: job.errorDescription,
      creationTime: job.creationTime,
      completionTime: job.completionTime,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
