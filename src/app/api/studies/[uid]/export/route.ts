import { randomUUID } from "node:crypto";
import { RequestError } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { sameOriginRequest } from "@/lib/api/same-origin";
import { studyUidParam } from "@/lib/api/study-param";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError } from "@/lib/backend/types";
import { assertWriteAllowed } from "@/lib/pacs-ops";

// 書き出し（ZIP。docs/spec.md の 3.5。段 5）。検査の画像の全部を、Orthanc の /studies/{id}/archive から受けて、そのまま流す。
// ZIP は患者の情報を含んだまま施設の外へ持ち出せる形になるので：
// - 役割（study.export）を確かめ、検証モードでは DEV_ALLOW_WRITE=true のときだけ通す。
// - このアプリの画面（同じ origin）からの要求だけを受ける（ほかのサイトから落とさせない）。
// - 落とす前に記録し（記録できなければ渡さない）、Orthanc が断れば失敗を記録する。
// - ファイルの名前に患者の情報を入れない。BFF には残さない（流すだけ）。

type Context = { params: Promise<{ uid: string }> };

export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    if (!sameOriginRequest(request)) {
      await audit(session, {
        action: "export",
        outcome: "denied",
        studyInstanceUid: uid,
        detail: { reason: "not-same-origin", site: request.headers.get("sec-fetch-site")?.slice(0, 32) ?? null },
      });
      throw new RequestError(403, "このアプリの画面から開いた要求だけを受ける");
    }
    await requirePermission(session, "study.export", { action: "export", studyInstanceUid: uid });
    await assertWriteAllowed(session, { action: "export", studyInstanceUid: uid });

    // 落とす検査は、URL の UID から Orthanc で引いたちょうど1件（2件以上は lookupStudy が 409）。その UID が求めたものと合うことも確かめる
    const backend = getBackend();
    const orthancId = await backend.lookupStudy(uid);
    const info = orthancId ? await backend.studyInfo(orthancId) : null;
    if (!orthancId || !info) return Response.json({ error: "検査が見つからない" }, { status: 404 });
    if (info.studyInstanceUid !== uid) {
      await audit(session, { action: "export", outcome: "denied", patientId: info.patientId, studyInstanceUid: uid, detail: { reason: "mismatch" } });
      return Response.json({ error: "Orthanc で引いた検査の StudyInstanceUID が、求めた UID と合わない" }, { status: 409 });
    }
    const patientId = info.patientId;

    // 取る前に「求めた」を記録する（記録できなければ渡さない）。結果（流し終えた・途中で切れた）は別の行に残し、要求の ID で結ぶ
    const requestId = randomUUID();
    const record = (outcome: "success" | "failed", phase: "request" | "result", extra: Record<string, unknown> = {}) =>
      audit(session, { action: "export", outcome, patientId, studyInstanceUid: uid, detail: { format: "zip", requestId, phase, ...extra } });
    await record("success", "request");
    let zip: Response;
    try {
      zip = await backend.exportStudy(orthancId);
    } catch (error) {
      await record("failed", "result", { status: error instanceof BackendError ? error.status : 502 });
      throw error;
    }
    if (!zip.body) {
      await record("failed", "result", { status: 502 });
      return Response.json({ error: "画像サーバーの答えに中身が無い" }, { status: 502 });
    }
    return new Response(watchedBody(zip.body, record), {
      status: 200,
      headers: {
        "content-type": "application/zip",
        // 名前は Orthanc の中の ID の頭だけ（患者 ID・氏名・UID を入れない）
        "content-disposition": `attachment; filename="study-${orthancId.slice(0, 8)}.zip"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

type ExportRecorder = (outcome: "success" | "failed", phase: "result", extra?: Record<string, unknown>) => Promise<unknown>;

/**
 * 本文を流しながら、終わり方を記録する：流し終えた（success・bytes）、Orthanc の側で切れた・時間切れ（failed・interrupted）、
 * ブラウザの側で切った（failed・cancelled）。結果の行を書き終えてから、本文を閉じる・誤りにする（書き終える前にプロセスが
 * 止まって「求めた」だけが残る間を狭める）。もう流し始めているので、記録できなくても流れは止めない（BFF のログに残す）
 */
function watchedBody(source: ReadableStream<Uint8Array>, record: ExportRecorder): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let bytes = 0;
  let settled = false;
  const settle = async (outcome: "success" | "failed", extra: Record<string, unknown>) => {
    if (settled) return;
    settled = true;
    try {
      await record(outcome, "result", { bytes, ...extra });
    } catch {
      console.error(JSON.stringify({ event: "export_result_not_recorded", outcome, ...extra }));
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        await settle("failed", { interrupted: true });
        controller.error(error);
        return;
      }
      if (chunk.done) {
        await settle("success", {});
        controller.close();
        return;
      }
      bytes += chunk.value.byteLength;
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      await settle("failed", { cancelled: true });
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}
