import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { assertRecentReauth } from "@/lib/auth/local-auth";
import { audit, auditIf, authContext, requirePermission, requireSession, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { stringValue, TAG } from "@/lib/backend/dicom-json";
import { BackendError, BackendUnknownError } from "@/lib/backend/types";
import { getDb } from "@/lib/db";
import { assertWriteAllowed, isRequestId, requestOutcome, rowsOfRequest, type RequestRow } from "@/lib/pacs-ops";

// 検査の削除（docs/spec.md の 3.5。段 5）。管理者だけ（study.delete）、理由を必須、再認証の後（AUTH_MODE=local）。
// 書き込みの操作の共通の決まり（3.5）を通す：CSRF・検証モードの止め・呼ぶ前の記録（記録できなければ消さない）・
// 呼んだ後の記録・要求の ID で二度流さない・答えが分からなければ結果不明。
// 削除は送り直さない。結果不明は、検査が Orthanc にまだあるかを読んで照らす（GET ?requestId=…。無ければ消えた）。
// 記録には「誰が・いつ・どの検査を（患者 ID と StudyInstanceUID）・理由」を残す。

type Context = { params: Promise<{ uid: string }> };

/** 理由の長さの上限（文字） */
const DELETE_REASON_MAX = 500;

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求の ID（UUID）の形が誤り"),
  reason: z.string().trim().min(1, "理由を書く").max(DELETE_REASON_MAX, `理由は ${DELETE_REASON_MAX} 文字まで`),
});

/** 大事な操作の前の再認証（AUTH_MODE=local。検証モードはモックだけなので求めない） */
async function assertReauth(session: Session) {
  if (!session.local) return;
  assertRecentReauth(await authContext(), session.local.row, session.local.user);
}

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { requestId, reason } = await readJson(request, Body, 4096);
    const denied = { action: "delete" as const, studyInstanceUid: uid, detail: { requestId } };
    await requirePermission(session, "study.delete", denied);
    await assertWriteAllowed(session, denied);
    await assertReauth(session);

    const db = await getDb();
    const prior = await rowsOfRequest(db, "delete", requestId);
    if (requestOutcome(prior).phase !== "none") return priorResponse(session, uid, requestId, prior);

    const backend = getBackend();
    const [dataset, orthancId, series] = await Promise.all([
      backend.studyDataset(uid),
      backend.lookupStudy(uid),
      backend.searchSeries(uid),
    ]);
    if (!dataset || !orthancId) return Response.json({ error: "検査が見つからない" }, { status: 404 });
    const patientId = stringValue(dataset, TAG.PatientID);
    const detail = {
      requestId,
      reason,
      series: series.length,
      instances: series.reduce((n, s) => n + (s.instanceCount ?? 0), 0),
    };

    // 消す前に「求めた」を記録する（記録できなければ消さない）。同じ要求の ID が並んだときは先の1つだけを通す
    const first = await auditIf(session, async (tx) => {
      const again = requestOutcome(await rowsOfRequest(tx, "delete", requestId)).phase !== "none";
      return {
        value: !again,
        fields: again ? null : { action: "delete", outcome: "success", patientId, studyInstanceUid: uid, detail: { ...detail, phase: "request" } },
      };
    });
    if (!first) return priorResponse(session, uid, requestId, await rowsOfRequest(db, "delete", requestId));

    const result = (outcome: "success" | "failed" | "unknown", extra: Record<string, unknown> = {}) =>
      audit(session, { action: "delete", outcome, patientId, studyInstanceUid: uid, detail: { requestId, phase: "result", ...extra } });
    try {
      await backend.deleteStudy(orthancId);
    } catch (error) {
      if (error instanceof BackendUnknownError) {
        await result("unknown").catch(() => console.error(JSON.stringify({ event: "delete_result_not_recorded", requestId })));
        return unknownResponse(requestId);
      }
      await result("failed", { status: error instanceof BackendError ? error.status : 502 });
      throw error;
    }
    try {
      await result("success");
    } catch {
      // Orthanc では消えたが、結果を記録できなかった：結果不明として返す（送り直させない。照らせば消えたと分かる）
      console.error(JSON.stringify({ event: "delete_result_not_recorded", requestId }));
      return unknownResponse(requestId);
    }
    return Response.json({ requestId, outcome: "deleted" });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 同じ要求のいまの結果。結果不明なら、検査が Orthanc にまだあるかを読んで照らし、分かった結果を記録に足す */
export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    const requestId = new URL(request.url).searchParams.get("requestId") ?? "";
    if (!isRequestId(requestId)) return Response.json({ error: "要求の ID（UUID）の形が誤り" }, { status: 400 });
    await requirePermission(session, "study.delete", { action: "delete", studyInstanceUid: uid, detail: { requestId } });
    const db = await getDb();
    const rows = await rowsOfRequest(db, "delete", requestId);
    const o = requestOutcome(rows);
    if (o.phase === "none") return Response.json({ requestId, outcome: "none" });
    if (o.actorId !== session.actorId || o.studyInstanceUid !== uid) {
      return Response.json({ error: "この要求の ID は、別の削除に使われている" }, { status: 409 });
    }
    if (o.outcome === "success" || o.outcome === "failed") return priorResponse(session, uid, requestId, rows);
    // 結果不明（呼んだ後の記録が無い・unknown）：Orthanc を読んで照らす
    const still = await getBackend().lookupStudy(uid);
    await audit(session, {
      action: "delete",
      outcome: still ? "failed" : "success",
      patientId: rows.find((r) => r.patientId)?.patientId ?? null,
      studyInstanceUid: uid,
      detail: { requestId, phase: "reconcile", studyPresent: !!still },
    });
    return Response.json({ requestId, outcome: still ? "not_deleted" : "deleted", reconciled: true });
  } catch (error) {
    return errorResponse(error);
  }
}

function unknownResponse(requestId: string): Response {
  return Response.json(
    { requestId, outcome: "unknown", error: "結果が分からない。もう一度消さずに、状態を確かめる" },
    { status: 202 },
  );
}

function priorResponse(session: Session, uid: string, requestId: string, rows: readonly RequestRow[]): Response {
  const o = requestOutcome(rows);
  if (o.actorId !== session.actorId || o.studyInstanceUid !== uid) {
    return Response.json({ error: "この要求の ID は、別の削除に使われている" }, { status: 409 });
  }
  if (o.outcome === "success") return Response.json({ requestId, outcome: "deleted", repeated: true });
  if (o.outcome === "failed") return Response.json({ requestId, outcome: "failed", repeated: true });
  return Response.json({ requestId, outcome: "unknown", repeated: true }, { status: 202 });
}
