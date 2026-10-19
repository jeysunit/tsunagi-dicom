import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { assertRecentReauth } from "@/lib/auth/local-auth";
import { audit, auditIf, authContext, requirePermission, requireSession, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError, BackendUnknownError, type Backend, type OrthancStudyInfo } from "@/lib/backend/types";
import { parsePatientName } from "@/lib/format/patient-name";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/roles";
import { assertWriteAllowed, isRequestId, requestOutcome, rowsOfRequest, unresolvedRequests, type RequestRow } from "@/lib/pacs-ops";

// 検査の削除（docs/spec.md の 3.5。段 5）。管理者だけ（study.delete）、理由を必須、再認証の後（AUTH_MODE=local）。
// 書き込みの操作の共通の決まり（3.5）を通す：CSRF・検証モードの止め・呼ぶ前の記録（記録できなければ消さない）・
// 呼んだ後の記録・要求の ID で二度流さない・答えが分からなければ結果不明。
// **違う検査を消さない**：
// - 消す検査は、BFF が URL の StudyInstanceUID から Orthanc で引いたものだけ（画面や本文の Orthanc の ID・患者 ID は受けない）。
// - 引いた結果がちょうど1件で、その検査の StudyInstanceUID が要求の UID と一致することを、消す直前に Orthanc から読み直して確かめる。
//   0件・2件以上（患者違いで同じ UID の検査があるなど）・不一致なら消さずに断り、記録する。
// - 確かめの画面（GET。消す検査の要点と版）で見せた版（Orthanc の LastUpdate）を要求に添えさせ、消す直前の版と違えば 409。
// 削除は送り直さない。結果不明は、検査が Orthanc にまだあるかを読んで照らす（GET ?requestId=…。無ければ消えた）。

type Context = { params: Promise<{ uid: string }> };

/** 理由の長さの上限（文字） */
const DELETE_REASON_MAX = 500;

/**
 * 結果不明の削除を「消えていない」と確定させるまでの猶予。BFF が DELETE を待つのは 30 秒（http.ts）だが、
 * 時間切れの後も Orthanc は消し続けることがあるので、求めてからこの間は、検査がまだあっても確定させない
 */
const DELETE_SETTLE_MS = 10 * 60_000;

function parseDetail(detail: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(detail ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求の ID（UUID）の形が誤り"),
  reason: z.string().trim().min(1, "理由を書く").max(DELETE_REASON_MAX, `理由は ${DELETE_REASON_MAX} 文字まで`),
  /** 確かめの画面で見せた検査の版（GET の version）。消す直前の版と違えば断る */
  version: z.string().min(1).max(64),
});

/** 大事な操作の前の再認証（AUTH_MODE=local。検証モードはモックだけなので求めない） */
async function assertReauth(session: Session) {
  if (!session.local) return;
  assertRecentReauth(await authContext(), session.local.row, session.local.user);
}

type Target = { kind: "ok"; info: OrthancStudyInfo } | { kind: "not_found" } | { kind: "ambiguous"; count: number } | { kind: "mismatch" };

/** URL の UID から、消してよい検査をちょうど1つ引く（Orthanc から読み直す） */
async function resolveTarget(backend: Backend, uid: string): Promise<Target> {
  const ids = await backend.lookupStudyIds(uid);
  if (ids.length === 0) return { kind: "not_found" };
  if (ids.length > 1) return { kind: "ambiguous", count: ids.length };
  const info = await backend.studyInfo(ids[0]!);
  if (!info) return { kind: "not_found" };
  if (info.studyInstanceUid !== uid) return { kind: "mismatch" };
  return { kind: "ok", info };
}

const REFUSALS = {
  not_found: { status: 404, error: "検査が見つからない" },
  ambiguous: { status: 409, error: "同じ StudyInstanceUID の検査が Orthanc に2つ以上ある。どれかを選んで消さない" },
  mismatch: { status: 409, error: "Orthanc で引いた検査の StudyInstanceUID が、求めた UID と合わない。消さない" },
  changed: { status: 409, error: "確かめの画面を出した後に、検査が変わった。もう一度確かめてから消す" },
} as const;

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { requestId, reason, version } = await readJson(request, Body, 4096);
    const denied = { action: "delete" as const, studyInstanceUid: uid, detail: { requestId } };
    await requirePermission(session, "study.delete", denied);
    await assertWriteAllowed(session, denied);
    await assertReauth(session);

    const db = await getDb();
    const prior = await rowsOfRequest(db, "delete", requestId);
    if (requestOutcome(prior).phase !== "none") return priorResponse(session, uid, requestId, prior);

    const backend = getBackend();
    const refuse = async (kind: keyof typeof REFUSALS, extra: Record<string, unknown> = {}, patientId: string | null = null) => {
      await audit(session, { ...denied, outcome: "denied", patientId, detail: { requestId, reason: kind, ...extra } });
      return Response.json({ error: REFUSALS[kind].error }, { status: REFUSALS[kind].status });
    };

    // 1回目の確かめ：UID からちょうど1件・UID が一致・確かめの画面の版と同じ
    const target = await resolveTarget(backend, uid);
    if (target.kind !== "ok") return refuse(target.kind, target.kind === "ambiguous" ? { count: target.count } : {});
    const { info } = target;
    if (info.version !== version) return refuse("changed", { shown: version, current: info.version }, info.patientId);

    const series = await backend.searchSeries(uid);
    const detail = {
      requestId,
      reason,
      version,
      // 照らし合わせで、この検査そのものが Orthanc にまだあるかを読むため（Orthanc の中の ID。患者の情報ではない）
      orthancId: info.orthancId,
      series: series.length,
      instances: series.reduce((n, s) => n + (s.instanceCount ?? 0), 0),
    };

    // 消す前に「求めた」を記録する（記録できなければ消さない）。同じ要求の ID が並んだときは先の1つだけを通す。
    // 同じ検査の削除で、まだ結果の分からない要求（処理中・結果不明）があれば、照らし合わせが済むまで断る
    type Begin = { kind: "repeated" } | { kind: "pending"; pending: string[] } | { kind: "first" };
    const begin = await auditIf<Begin>(session, async (tx) => {
      if (requestOutcome(await rowsOfRequest(tx, "delete", requestId)).phase !== "none") {
        return { value: { kind: "repeated" as const }, fields: null };
      }
      const pending = await unresolvedRequests(tx, "delete", uid, () => true);
      if (pending.length > 0) {
        return {
          value: { kind: "pending" as const, pending },
          fields: { action: "delete", outcome: "denied", patientId: info.patientId, studyInstanceUid: uid, detail: { requestId, reason: "unresolved", pending } },
        };
      }
      return {
        value: { kind: "first" as const },
        fields: { action: "delete", outcome: "success", patientId: info.patientId, studyInstanceUid: uid, detail: { ...detail, phase: "request" } },
      };
    });
    if (begin.kind === "repeated") return priorResponse(session, uid, requestId, await rowsOfRequest(db, "delete", requestId));
    if (begin.kind === "pending") {
      return Response.json(
        { error: "この検査を消した結果が、まだ分からない。消し直さずに、先にその結果を確かめる", pendingRequestIds: begin.pending },
        { status: 409 },
      );
    }

    const result = (outcome: "success" | "failed" | "unknown", extra: Record<string, unknown> = {}) =>
      audit(session, { action: "delete", outcome, patientId: info.patientId, studyInstanceUid: uid, detail: { requestId, phase: "result", ...extra } });

    // 消す直前に、もう一度 Orthanc から読み直して確かめる（記録の間に、検査が替わっていないこと）。読めなければ消さずに失敗として残す
    let again: Target;
    try {
      again = await resolveTarget(backend, uid);
    } catch (error) {
      await result("failed", { refused: "reread_failed" });
      throw error;
    }
    if (again.kind !== "ok" || again.info.orthancId !== info.orthancId || again.info.version !== version) {
      const why = again.kind !== "ok" ? again.kind : "changed";
      await result("failed", { refused: why });
      return Response.json({ error: REFUSALS[why].error }, { status: REFUSALS[why].status });
    }

    try {
      await backend.deleteStudy(info.orthancId);
    } catch (error) {
      if (error instanceof BackendUnknownError) {
        await result("unknown").catch(() => console.error(JSON.stringify({ event: "delete_result_not_recorded", requestId })));
        return unknownResponse(requestId);
      }
      // Orthanc が断った（受けなかったと分かる答え）。答えの要点を残し、画面には「消えていない」と返す
      const message = error instanceof Error ? error.message.slice(0, 200) : "";
      await result("failed", { status: error instanceof BackendError ? error.status : 502, message });
      return Response.json({ requestId, outcome: "failed", error: `消せなかった（${message}）` }, { status: 502 });
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

/**
 * GET ?requestId=… ：同じ要求のいまの結果。結果不明なら、検査が Orthanc にまだあるかを読んで照らし、分かった結果を記録に足す。
 * GET（requestId なし）：確かめの画面に出す、消す検査の要点と版（Orthanc から読む。消すときに版を添える）
 */
export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    const requestId = new URL(request.url).searchParams.get("requestId");
    if (requestId === null) return await preview(session, uid);
    if (!isRequestId(requestId)) return Response.json({ error: "要求の ID（UUID）の形が誤り" }, { status: 400 });
    await requirePermission(session, "study.delete", { action: "delete", studyInstanceUid: uid, detail: { requestId } });
    const db = await getDb();
    const rows = await rowsOfRequest(db, "delete", requestId);
    const o = requestOutcome(rows);
    if (o.phase === "none") return Response.json({ requestId, outcome: "none" });
    // 求めた本人のほか、照らし合わせの役割（pacs.reconcile。管理者）なら、ほかの人の要求も照らせる（止まった削除を片付けるため）
    if ((o.actorId !== session.actorId && !can(session.role, "pacs.reconcile")) || o.studyInstanceUid !== uid) {
      return Response.json({ error: "この要求の ID は、別の削除に使われている" }, { status: 409 });
    }
    if (o.outcome === "success" || o.outcome === "failed") return priorResponse(session, uid, requestId, rows, true);
    // 結果不明（呼んだ後の記録が無い・unknown）：Orthanc を読んで照らす。消したはずの検査（求めた行の Orthanc の ID）がまだあるか
    const requestRow = rows.find((r) => parseDetail(r.detail).phase === "request");
    const orthancId = requestRow ? parseDetail(requestRow.detail).orthancId : undefined;
    const backend = getBackend();
    const still = typeof orthancId === "string" ? (await backend.studyInfo(orthancId)) !== null : (await backend.lookupStudyIds(uid)).length > 0;
    // まだあっても、Orthanc が消している途中かもしれない。求めてから DELETE_SETTLE_MS の間は確定させない（記録に足さない）
    const age = requestRow ? Date.now() - requestRow.occurredAt.getTime() : Infinity;
    if (still && age < DELETE_SETTLE_MS) {
      return Response.json({ requestId, outcome: "unknown", studyPresent: true, retryAfterSeconds: Math.ceil((DELETE_SETTLE_MS - age) / 1000) }, { status: 202 });
    }
    await audit(session, {
      action: "delete",
      outcome: still ? "failed" : "success",
      patientId: rows.find((r) => r.patientId)?.patientId ?? null,
      studyInstanceUid: uid,
      detail: { requestId, phase: "reconcile", studyPresent: still },
    });
    return Response.json({ requestId, outcome: still ? "not_deleted" : "deleted", reconciled: true });
  } catch (error) {
    return errorResponse(error);
  }
}

async function preview(session: Session, uid: string): Promise<Response> {
  await requirePermission(session, "study.delete", { action: "delete", studyInstanceUid: uid, detail: { via: "preview" } });
  const backend = getBackend();
  const target = await resolveTarget(backend, uid);
  if (target.kind !== "ok") return Response.json({ error: REFUSALS[target.kind].error }, { status: REFUSALS[target.kind].status });
  const { info } = target;
  const series = await backend.searchSeries(uid);
  const name = parsePatientName(info.patientName);
  // 確かめの画面で患者の値を見せるので、詳細を開いたのと同じく記録する
  await audit(session, { action: "view_study", patientId: info.patientId, studyInstanceUid: uid, detail: { via: "delete_preview" } });
  return Response.json({
    version: info.version,
    patientId: info.patientId,
    patientName: name.name,
    patientKana: name.kana,
    studyDate: info.studyDate,
    seriesCount: series.length,
    instanceCount: series.reduce((n, s) => n + (s.instanceCount ?? 0), 0),
  });
}

function unknownResponse(requestId: string): Response {
  return Response.json(
    { requestId, outcome: "unknown", error: "結果が分からない。もう一度消さずに、状態を確かめる" },
    { status: 202 },
  );
}

function priorResponse(session: Session, uid: string, requestId: string, rows: readonly RequestRow[], allowReconciler = false): Response {
  const o = requestOutcome(rows);
  const actorOk = o.actorId === session.actorId || (allowReconciler && can(session.role, "pacs.reconcile"));
  if (!actorOk || o.studyInstanceUid !== uid) {
    return Response.json({ error: "この要求の ID は、別の削除に使われている" }, { status: 409 });
  }
  if (o.outcome === "success") return Response.json({ requestId, outcome: "deleted", repeated: true });
  if (o.outcome === "failed") return Response.json({ requestId, outcome: "failed", repeated: true });
  return Response.json({ requestId, outcome: "unknown", repeated: true }, { status: 202 });
}
