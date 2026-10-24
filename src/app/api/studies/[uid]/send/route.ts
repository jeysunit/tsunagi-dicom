import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { audit, auditIf, requirePermission, requireSession, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { stringValue, TAG } from "@/lib/backend/dicom-json";
import { isModalityName } from "@/lib/backend/orthanc-rest";
import { BackendError, BackendUnknownError } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import {
  assertWriteAllowed,
  clip,
  isRequestId,
  requestOutcome,
  rowsOfRequest,
  signJobToken,
  unresolvedRequests,
  type RequestRow,
} from "@/lib/pacs-ops";

// ほかの機器へ送る（docs/spec.md の 3.4。段 4）。書き込みの操作の共通の決まり（3.5）を通す：
// 役割（study.send）・CSRF・検証モードの書き込みの止め・呼ぶ前の記録（記録できなければ呼ばない）・呼んだ後の記録・
// 要求の ID で二度流さない・答えが分からなければ結果不明。
// Orthanc には C-STORE の送信（/modalities/{id}/store）を非同期で求め、仕事の ID を暗号化した token にして画面へ渡す。
// GET（?requestId=…）は、同じ要求のいまの結果を返す（送り直さずに確かめる道）。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({
  modality: z.string().min(1).max(64),
  requestId: z.string().refine(isRequestId, "要求ID が正しくありません"),
});

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { modality, requestId } = await readJson(request, Body, 512);
    // 断った行は phase を持たない（「求めた」の行と取り違えないように）
    const denied = { action: "send" as const, studyInstanceUid: uid, detail: { requestId, modality: clip(modality) } };
    await requirePermission(session, "study.send", denied);
    await assertWriteAllowed(session, denied);
    if (!isModalityName(modality)) return Response.json({ error: "接続先の名称が正しくありません" }, { status: 400 });

    const db = await getDb();
    const backend = getBackend();
    // 同じ要求の ID がもう流れていれば、Orthanc を呼び直さず、その記録を返す
    const prior = await rowsOfRequest(db, "send", requestId, uid);
    if (requestOutcome(prior).phase !== "none") return priorResponse(session, requestId, uid, modality, prior);

    const [dataset, orthancId, modalities] = await Promise.all([
      backend.studyDataset(uid),
      backend.lookupStudy(uid),
      backend.listModalities(),
    ]);
    const target = modalities.find((m) => m.id === modality);
    if (!dataset || !orthancId) return Response.json({ error: "検査が見つかりません" }, { status: 404 });
    if (!target) return Response.json({ error: "接続先が登録されていません" }, { status: 404 });
    const patientId = stringValue(dataset, TAG.PatientID);
    const detail = { requestId, modality, aet: target.aet };

    // 呼ぶ前に「求めた」を記録する。記録の並びの中で、次の2つを確かめてから書く：
    // - 同じ要求の ID が並んで届いたときは、先の1つだけを通す
    // - 同じ検査を同じ送り先へ送った要求で、結果の分からないもの（照らし合わせの前）があれば、新しい要求でも断る（重ねて送らない）
    type Begin = { kind: "repeated" } | { kind: "pending"; pending: string[] } | { kind: "first" };
    const begin = await auditIf<Begin>(session, async (tx) => {
      if (requestOutcome(await rowsOfRequest(tx, "send", requestId, uid)).phase !== "none") {
        return { value: { kind: "repeated" as const }, fields: null };
      }
      const pending = await unresolvedRequests(tx, "send", uid, (o) => o.modality === modality);
      if (pending.length > 0) {
        return {
          value: { kind: "pending" as const, pending },
          fields: { action: "send", outcome: "denied", patientId, studyInstanceUid: uid, detail: { ...detail, reason: "unresolved", pending } },
        };
      }
      return {
        value: { kind: "first" as const },
        fields: { action: "send", outcome: "success", patientId, studyInstanceUid: uid, detail: { ...detail, phase: "request" } },
      };
    });
    if (begin.kind === "repeated") return priorResponse(session, requestId, uid, modality, await rowsOfRequest(db, "send", requestId, uid));
    if (begin.kind === "pending") {
      return Response.json(
        {
          error: "同じ送信先への前回の送信結果が未確認です。先に状態を確認してください",
          pendingRequestIds: begin.pending,
        },
        { status: 409 },
      );
    }

    const result = (outcome: "success" | "failed" | "unknown", extra: Record<string, unknown> = {}) =>
      audit(session, { action: "send", outcome, patientId, studyInstanceUid: uid, detail: { ...detail, phase: "result", ...extra } });

    let jobId: string;
    try {
      ({ jobId } = await backend.sendStudy(modality, orthancId));
    } catch (error) {
      if (error instanceof BackendUnknownError) {
        // 結果不明。記録に失敗しても、結果不明として返す（送り直しを誘わない）
        await result("unknown").catch((e: unknown) => logRecordFailure(requestId, null, e));
        return unknownResponse(requestId);
      }
      const status = error instanceof BackendError ? error.status : 502;
      await result("failed", { status });
      throw error;
    }
    try {
      await result("success", { jobId });
    } catch (error) {
      // Orthanc は受けたが、結果を記録できなかった。もう一度だけ書き、だめなら結果不明として返す（送り直させない）
      try {
        await result("success", { jobId, retried: true });
      } catch {
        logRecordFailure(requestId, jobId, error);
        return unknownResponse(requestId);
      }
    }
    const job = signJobToken({ jobId, requestId, studyInstanceUid: uid, modality, actorId: session.actorId }, getConfig().sessionSecret);
    return Response.json({ requestId, outcome: "accepted", job }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 同じ要求のいまの結果（送り直さずに確かめる）。画面が答えを受け取れなかったときに使う */
export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    const requestId = new URL(request.url).searchParams.get("requestId") ?? "";
    if (!isRequestId(requestId)) return Response.json({ error: "要求ID が正しくありません" }, { status: 400 });
    await requirePermission(session, "study.send", { action: "send", studyInstanceUid: uid, detail: { requestId } });
    const rows = await rowsOfRequest(await getDb(), "send", requestId, uid);
    if (requestOutcome(rows).phase === "none") return Response.json({ requestId, outcome: "none" });
    return priorResponse(session, requestId, uid, null, rows);
  } catch (error) {
    return errorResponse(error);
  }
}

/** 結果の記録に失敗したとき：患者の値は出さず、照らすための要求の ID と仕事の ID だけを残す */
function logRecordFailure(requestId: string, jobId: string | null, error: unknown) {
  console.error(
    JSON.stringify({ event: "send_result_not_recorded", requestId, jobId, error: error instanceof Error ? error.name : "unknown" }),
  );
}

function unknownResponse(requestId: string): Response {
  return Response.json(
    { requestId, outcome: "unknown", error: "送信結果を確認できません。再送信せずに状態を確認してください" },
    { status: 202 },
  );
}

/**
 * 前の同じ要求の結果を返す。求めた利用者・検査・送り先が違えば 409（使い回しで、別の送信の「受けた」を返さない）。
 * token に入れる検査と送り先は、記録の側の値を使う
 */
function priorResponse(session: Session, requestId: string, uid: string, modality: string | null, rows: readonly RequestRow[]): Response {
  const o = requestOutcome(rows);
  if (o.actorId !== session.actorId || o.studyInstanceUid !== uid || (modality !== null && o.modality !== modality)) {
    return Response.json({ error: "この要求ID は別の送信に使われています。新しい送信として送信してください" }, { status: 409 });
  }
  if (o.jobId && o.studyInstanceUid && o.modality) {
    const job = signJobToken(
      { jobId: o.jobId, requestId, studyInstanceUid: o.studyInstanceUid, modality: o.modality, actorId: session.actorId },
      getConfig().sessionSecret,
    );
    return Response.json({ requestId, outcome: "accepted", job, repeated: true }, { status: 202 });
  }
  if (o.outcome === "failed") return Response.json({ requestId, outcome: "failed", repeated: true });
  // 仕事の ID は無いが、管理者の照らし合わせで届いたと分かった
  if (o.outcome === "success") return Response.json({ requestId, outcome: "delivered", repeated: true });
  return Response.json({ requestId, outcome: "unknown", repeated: true }, { status: 202 });
}
