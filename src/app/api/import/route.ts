import { createHash } from "node:crypto";
import { RequestError, checkedScreenWrite } from "@/lib/api/auth-route";
import { readLimitedBytes } from "@/lib/api/body";
import { errorResponse } from "@/lib/api/respond";
import { audit, auditIf, requirePermission, requireSession, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError, BackendUnknownError } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { DicomFileError, readDicomFileHeader, type DicomFileHeader } from "@/lib/dicom-file";
import { assertWriteAllowed, clip, isRequestId, requestOutcome, rowsOfRequest, type RequestRow } from "@/lib/pacs-ops";

// インポート（docs/spec.md の 3.5 の「取り込み」。段 6）。DICOM のファイル 1 つを、本文のバイトのまま受けて Orthanc へ入れる
// （POST /instances）。画面は複数のファイルを 1 つずつ送る（BFF が持つのは 1 つのファイルの分のメモリだけ）。
// 書き込みの操作の共通の決まり（3.5）を通す：役割（study.import）・CSRF・検証モードの書き込みの止め・呼ぶ前の記録
// （記録できなければ呼ばない）・呼んだ後の記録・要求の ID で二度流さない・答えが分からなければ結果不明。
// Orthanc へ渡す前に、大きさの上限（IMPORT_MAX_MB）と DICOM のファイルの形（"DICM" と File Meta Information）を確かめて断る。
// 新しく入った画像の検査には、インポートの印（Orthanc のラベル）を付ける（検査一覧の「インポート」の印）。
// 結果不明は、GET（?requestId=…）で SOP Instance UID を引き当てて照らす。

const header = (request: Request, name: string) => request.headers.get(name) ?? "";

/** 画面が付ける、まとめて選んだファイルの組（記録の「ファイルの数」）。無ければ記録しない */
function batchOf(request: Request) {
  const id = header(request, "x-import-batch");
  const index = Number(header(request, "x-import-index"));
  const total = Number(header(request, "x-import-total"));
  if (!isRequestId(id) || !Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < index || total > 100_000) return {};
  return { batch: { id, index, total } };
}

/** ファイルから読んだ値を記録に入れる形（制御文字を見える形にし、長さを切る） */
// eslint-disable-next-line no-control-regex -- 制御文字そのものを見つけるための式
const recorded = (value: string) => clip(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`));

export async function POST(request: Request) {
  try {
    const session = await checkedScreenWrite(request);
    const requestId = header(request, "x-request-id");
    if (!isRequestId(requestId)) return Response.json({ error: "要求ID が正しくありません" }, { status: 400 });
    const base = { requestId, ...batchOf(request) };
    // 断った行は phase を持たない（「求めた」の行と取り違えないように）
    const denied = { action: "import" as const, detail: base };
    await requirePermission(session, "study.import", denied);
    await assertWriteAllowed(session, denied);

    const maxMb = getConfig().screen.importMaxMb;
    const file = await readLimitedBytes(request, maxMb * 1024 * 1024);
    if (file === null) {
      await audit(session, { action: "import", outcome: "denied", detail: { ...base, reason: "too_large", maxMb } });
      throw new RequestError(413, `ファイルが大きすぎます（上限 ${maxMb} MB）`);
    }
    let dicom: DicomFileHeader;
    try {
      dicom = readDicomFileHeader(file);
    } catch (error) {
      if (!(error instanceof DicomFileError)) throw error;
      await audit(session, { action: "import", outcome: "denied", detail: { ...base, reason: error.reason, bytes: file.byteLength } });
      throw new RequestError(400, error.message);
    }
    const uid = dicom.studyInstanceUid;
    const patientId = recorded(dicom.patientId);
    // 要求の ID はファイルに結ぶ（同じ ID で別のファイルを送ったとき、前のファイルの結果を返して画像を抜かさない）
    const sha256 = createHash("sha256").update(file).digest("hex");
    const detail = { ...base, bytes: file.byteLength, sha256, sopInstanceUid: dicom.sopInstanceUid, transferSyntaxUid: dicom.transferSyntaxUid };
    const same = { sopInstanceUid: dicom.sopInstanceUid, sha256 };

    const db = await getDb();
    const prior = await rowsOfRequest(db, "import", requestId, uid);
    if (requestOutcome(prior).phase !== "none") return priorResponse(session, requestId, uid, prior, same);

    // 呼ぶ前に「求めた」を記録する。同じ要求の ID が並んで届いたときは、先の1つだけを通す
    const first = await auditIf<boolean>(session, async (tx) => {
      if (requestOutcome(await rowsOfRequest(tx, "import", requestId, uid)).phase !== "none") return { value: false, fields: null };
      return {
        value: true,
        fields: { action: "import", outcome: "success", patientId, studyInstanceUid: uid, detail: { ...detail, phase: "request" } },
      };
    });
    if (!first) return priorResponse(session, requestId, uid, await rowsOfRequest(db, "import", requestId, uid), same);

    const result = (outcome: "success" | "failed" | "unknown", extra: Record<string, unknown> = {}) =>
      audit(session, { action: "import", outcome, patientId, studyInstanceUid: uid, detail: { ...detail, phase: "result", ...extra } });

    const backend = getBackend();
    let stored: Awaited<ReturnType<typeof backend.importInstance>>;
    try {
      stored = await backend.importInstance(file);
    } catch (error) {
      if (error instanceof BackendUnknownError) {
        await result("unknown").catch(() => logRecordFailure(requestId));
        return unknownResponse(requestId, uid);
      }
      const status = error instanceof BackendError ? error.status : 502;
      await result("failed", { status });
      throw error;
    }
    // 新しく入った画像の検査にだけ印を付ける（もうあった画像は、装置から届いた検査でもありうる）。印を付けられなくても、
    // 画像は入っているので成功とし、付けられなかったことを記録に残す
    let labeled = false;
    if (stored.status === "Success") {
      try {
        await backend.labelImported(stored.orthancStudyId);
        labeled = true;
      } catch {
        labeled = false;
      }
    }
    try {
      await result("success", { status: stored.status, orthancStudyId: stored.orthancStudyId, labeled });
    } catch {
      // Orthanc は受けたが、結果を記録できなかった。照らせるように結果不明として返す
      logRecordFailure(requestId);
      return unknownResponse(requestId, uid);
    }
    return Response.json({ requestId, outcome: stored.status === "Success" ? "stored" : "already", studyInstanceUid: uid, labeled });
  } catch (error) {
    return errorResponse(error);
  }
}

/** 同じ要求のいまの結果（送り直さずに確かめる）。結果不明なら、SOP Instance UID を引き当てて照らす */
export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const params = new URL(request.url).searchParams;
    const requestId = params.get("requestId") ?? "";
    if (!isRequestId(requestId)) return Response.json({ error: "要求ID が正しくありません" }, { status: 400 });
    await requirePermission(session, "study.import", { action: "import", detail: { requestId } });
    const db = await getDb();
    const rows = await rowsOfRequest(db, "import", requestId, params.get("study") ?? "");
    const o = requestOutcome(rows);
    if (o.phase === "none") return Response.json({ requestId, outcome: "none" });
    if (o.actorId !== session.actorId) return Response.json({ error: "この要求ID は別のインポートに使われています" }, { status: 409 });
    if (o.phase === "requested" || o.outcome === "unknown") {
      const sop = requestFile(rows)?.sopInstanceUid;
      const backend = getBackend();
      const orthancStudyId = sop ? await backend.findInstanceStudy(sop) : null;
      // 入っていると読めたときだけ成功を足す（画像の検査が、求めた検査と同じ StudyInstanceUID のときだけ）。
      // 無いだけでは失敗と確定しない（Orthanc が書き終える前の照らしもありうる）
      const info = orthancStudyId ? await backend.studyInfo(orthancStudyId) : null;
      if (orthancStudyId && info && info.studyInstanceUid === o.studyInstanceUid) {
        await audit(session, {
          action: "import",
          outcome: "success",
          studyInstanceUid: o.studyInstanceUid,
          detail: { requestId, phase: "reconcile", orthancStudyId },
        });
        return Response.json({ requestId, outcome: "stored", studyInstanceUid: o.studyInstanceUid, reconciled: true });
      }
    }
    return priorResponse(session, requestId, o.studyInstanceUid ?? "", rows);
  } catch (error) {
    return errorResponse(error);
  }
}

/** 「求めた」の行に残したファイル（SOP Instance UID と SHA-256）。無ければ null */
function requestFile(rows: readonly RequestRow[]): { sopInstanceUid: string; sha256: string } | null {
  for (const row of rows) {
    try {
      const d = JSON.parse(row.detail ?? "{}") as Record<string, unknown>;
      if (d.phase === "request" && typeof d.sopInstanceUid === "string" && typeof d.sha256 === "string") {
        return { sopInstanceUid: d.sopInstanceUid, sha256: d.sha256 };
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** 結果の記録に失敗したとき：患者の値は出さず、照らすための要求の ID だけを残す */
function logRecordFailure(requestId: string) {
  console.error(JSON.stringify({ event: "import_result_not_recorded", requestId }));
}

function unknownResponse(requestId: string, uid: string): Response {
  return Response.json(
    { requestId, outcome: "unknown", studyInstanceUid: uid, error: "インポートの結果を確認できません。状態を確認してください" },
    { status: 202 },
  );
}

/**
 * 前の同じ要求の結果を返す。求めた利用者・検査・ファイル（POST のときだけ比べる）が違えば 409
 * （使い回しで、別のインポートの結果を返さない）
 */
function priorResponse(
  session: Session,
  requestId: string,
  uid: string,
  rows: readonly RequestRow[],
  file?: { sopInstanceUid: string; sha256: string },
): Response {
  const o = requestOutcome(rows);
  const recordedFile = requestFile(rows);
  const otherFile = file && (recordedFile?.sopInstanceUid !== file.sopInstanceUid || recordedFile?.sha256 !== file.sha256);
  if (o.actorId !== session.actorId || o.studyInstanceUid !== uid || otherFile) {
    return Response.json({ error: "この要求ID は別のインポートに使われています。新しいインポートとして送ってください" }, { status: 409 });
  }
  if (o.outcome === "failed") return Response.json({ requestId, outcome: "failed", studyInstanceUid: uid, repeated: true });
  if (o.outcome === "success") return Response.json({ requestId, outcome: "stored", studyInstanceUid: uid, repeated: true });
  return Response.json({ requestId, outcome: "unknown", studyInstanceUid: uid, repeated: true }, { status: 202 });
}
