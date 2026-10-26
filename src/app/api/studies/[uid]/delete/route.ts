import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { assertRecentReauth } from "@/lib/auth/local-auth";
import { can } from "@/lib/auth/roles";
import { audit, auditIf, authContext, requirePermission, requireSession, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError, BackendUnknownError, type Backend, type OrthancStudyInfo } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { parsePatientName } from "@/lib/format/patient-name";
import {
  assertWriteAllowed,
  DELETE_DISPATCH_DEADLINE_MS,
  deletedStudyStillPresent,
  isRequestId,
  openDeleteConfirm,
  requestOutcome,
  rowsOfRequest,
  signDeleteConfirm,
  unresolvedRequests,
  type DeleteConfirmPayload,
  type RequestRow,
} from "@/lib/pacs-ops";

// 検査の削除（docs/spec.md の 3.5。段 5）。管理者だけ（study.delete）、理由を必須、再認証の後（AUTH_MODE=local）。
// 書き込みの操作の共通の決まり（3.5）を通す：CSRF・検証モードの止め・呼ぶ前の記録（記録できなければ消さない）・
// 呼んだ後の記録・要求の ID で二度流さない・答えが分からなければ結果不明。
// **違う検査を消さない**：
// - 消す検査は、BFF が URL の StudyInstanceUID から Orthanc で引いたものだけ（画面や本文の Orthanc の ID・患者 ID は受けない）。
// - 引いた結果がちょうど1件で、その検査の StudyInstanceUID が要求の UID と一致すること。0件・2件以上・不一致なら消さずに断り、記録する。
// - 確かめの画面（GET）で見せた検査（Orthanc の中の ID・UID・患者 ID・版）を、サーバーの秘密で暗号化した短い期限の token に結ぶ。
//   消すときは、その token の中身の全部が、いまの検査と一致するときだけ消す（Orthanc の中の ID は患者 ID にもよるので、
//   同じ UID・同じ版の別の患者の検査に替わっても、ID と患者 ID で見分ける）。「求めた」を記録した後、DELETE の直前にもう一度確かめる。
// 削除は送り直さない。結果不明は、検査が Orthanc に無いと読めたときだけ「消えた」と確定する。まだあっても「消えていない」とは
// 確定しない（先の DELETE が止まった・終わった証拠が無い）。それを解くのは、管理者が状況を確かめて手で解く操作（./resolve）だけ。

type Context = { params: Promise<{ uid: string }> };

/** 理由の長さの上限（文字） */
const DELETE_REASON_MAX = 500;

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求ID が正しくありません"),
  reason: z.string().trim().min(1, "削除理由を入力してください").max(DELETE_REASON_MAX, `削除理由は ${DELETE_REASON_MAX} 文字までです`),
  /** 確かめの画面（GET）が返した token。見せた検査と、いまの検査が全部同じときだけ消す */
  confirmToken: z.string().min(1).max(2048),
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

/** 確かめの画面で見せた検査と、いまの検査で違う項目の名前（値は記録に入れない） */
function differences(shown: DeleteConfirmPayload, now: OrthancStudyInfo): string[] {
  const out: string[] = [];
  if (shown.orthancId !== now.orthancId) out.push("orthancId");
  if (shown.studyInstanceUid !== now.studyInstanceUid) out.push("studyInstanceUid");
  if (shown.patientId !== now.patientId) out.push("patientId");
  if (shown.version !== now.version) out.push("version");
  return out;
}

const REFUSALS = {
  // 画面に出す文言（docs/spec.md の 2.2）
  not_found: { status: 404, error: "検査が見つかりません" },
  ambiguous: { status: 409, error: "同じ StudyInstanceUID の検査が複数あるため削除できません" },
  mismatch: { status: 409, error: "検査の StudyInstanceUID が一致しないため削除できません" },
  changed: { status: 409, error: "確認の後に検査が更新されました。もう一度確認してください" },
  confirm_invalid: { status: 409, error: "確認画面の有効期限が切れました。もう一度確認してから削除してください" },
} as const;

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { requestId, reason, confirmToken } = await readJson(request, Body, 8192);
    const denied = { action: "delete" as const, studyInstanceUid: uid, detail: { requestId } };
    await requirePermission(session, "study.delete", denied);
    await assertWriteAllowed(session, denied);
    await assertReauth(session);

    const db = await getDb();
    const prior = await rowsOfRequest(db, "delete", requestId, uid);
    if (requestOutcome(prior).phase !== "none") return priorResponse(session, uid, requestId, prior);

    const backend = getBackend();
    const refuse = async (kind: keyof typeof REFUSALS, extra: Record<string, unknown> = {}, patientId: string | null = null) => {
      await audit(session, { ...denied, outcome: "denied", patientId, detail: { requestId, reason: kind, ...extra } });
      return Response.json({ error: REFUSALS[kind].error }, { status: REFUSALS[kind].status });
    };

    // 確かめの画面の token：この利用者が、この UID の検査で、期限の中に開いたもの
    const shown = openDeleteConfirm(confirmToken, getConfig().sessionSecret);
    if (!shown || shown.actorId !== session.actorId || shown.studyInstanceUid !== uid) return refuse("confirm_invalid");

    // 1回目の確かめ：UID からちょうど1件・UID が一致・確かめの画面で見せた検査（ID・UID・患者 ID・版）と全部同じ
    const target = await resolveTarget(backend, uid);
    if (target.kind !== "ok") return refuse(target.kind, target.kind === "ambiguous" ? { count: target.count } : {}, shown.patientId);
    const { info } = target;
    const changed = differences(shown, info);
    if (changed.length > 0) return refuse("changed", { changed }, shown.patientId);

    const series = await backend.searchSeries(uid);
    const detail = {
      requestId,
      reason,
      version: info.version,
      // 照らし合わせで、この検査そのものが Orthanc にまだあるかを読むため（Orthanc の中の ID。患者の情報ではない）
      orthancId: info.orthancId,
      series: series.length,
      instances: series.reduce((n, s) => n + (s.instanceCount ?? 0), 0),
    };

    // 消す前に「求めた」を記録する（記録できなければ消さない）。同じ要求の ID が並んだときは先の1つだけを通す。
    // 同じ検査の削除で、まだ結果の分からない要求（処理中・結果不明）があれば、照らし合わせが済むまで断る
    type Begin = { kind: "repeated" } | { kind: "pending"; pending: string[] } | { kind: "first" };
    const begin = await auditIf<Begin>(session, async (tx) => {
      if (requestOutcome(await rowsOfRequest(tx, "delete", requestId, uid)).phase !== "none") {
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
    if (begin.kind === "repeated") return priorResponse(session, uid, requestId, await rowsOfRequest(db, "delete", requestId, uid));
    if (begin.kind === "pending") {
      return Response.json(
        { error: "前回の削除結果が未確認です。先に状態を確認してください", pendingRequestIds: begin.pending },
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
    const changedLater = again.kind === "ok" ? differences(shown, again.info) : [];
    if (again.kind !== "ok" || changedLater.length > 0) {
      const why = again.kind !== "ok" ? again.kind : "changed";
      await result("failed", { refused: why, ...(changedLater.length > 0 ? { changed: changedLater } : {}) });
      return Response.json({ error: REFUSALS[why].error }, { status: REFUSALS[why].status });
    }

    // DELETE を送る直前に、記録の並びの中で、自分の要求がまだ有効か（ほかで解かれていない・決めた時間の中）を確かめ、
    // 「送る」の行（dispatch）を足す。この行の後でだけ、管理者は結果不明の削除を手で解ける（./resolve）
    type Dispatch = "go" | "settled" | "stale";
    const dispatch = await auditIf<Dispatch>(session, async (tx) => {
      const o = requestOutcome(await rowsOfRequest(tx, "delete", requestId, uid));
      if (o.phase !== "requested" || o.dispatched) return { value: "settled", fields: null };
      const age = o.requestedAt ? Date.now() - o.requestedAt.getTime() : Infinity;
      if (age > DELETE_DISPATCH_DEADLINE_MS) {
        return {
          value: "stale",
          fields: { action: "delete", outcome: "failed", patientId: info.patientId, studyInstanceUid: uid, detail: { requestId, phase: "result", refused: "stale" } },
        };
      }
      return {
        value: "go",
        fields: { action: "delete", outcome: "success", patientId: info.patientId, studyInstanceUid: uid, detail: { requestId, phase: "dispatch" } },
      };
    });
    if (dispatch === "settled") {
      return Response.json({ requestId, error: "この削除は実行前にほかで解除されたため、中止しました（管理者が解除したなど）" }, { status: 409 });
    }
    if (dispatch === "stale") {
      return Response.json({ requestId, error: "時間切れのため削除を中止しました。もう一度確認してください" }, { status: 409 });
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
      return Response.json({ requestId, outcome: "failed", error: `削除できませんでした（${message}）` }, { status: 502 });
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
 * GET ?requestId=… ：同じ要求のいまの結果。結果不明なら、消したはずの検査が Orthanc にまだあるかを読む。
 *   無ければ「消えた」と記録に足す。まだあれば確定させず、結果不明のまま返す（管理者が ./resolve で解く）。
 * GET（requestId なし）：確かめの画面に出す、消す検査の要点と、確かめの token（Orthanc から読む。消すときに token を添える）
 */
export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    const requestId = new URL(request.url).searchParams.get("requestId");
    if (requestId === null) return await preview(session, uid);
    if (!isRequestId(requestId)) return Response.json({ error: "要求ID が正しくありません" }, { status: 400 });
    await requirePermission(session, "study.delete", { action: "delete", studyInstanceUid: uid, detail: { requestId } });
    const db = await getDb();
    const rows = await rowsOfRequest(db, "delete", requestId, uid);
    const o = requestOutcome(rows);
    if (o.phase === "none") return Response.json({ requestId, outcome: "none" });
    // 求めた本人のほか、照らし合わせの役割（pacs.reconcile。管理者）なら、ほかの人の要求も照らせる（止まった削除を片付けるため）
    if ((o.actorId !== session.actorId && !can(session.role, "pacs.reconcile")) || o.studyInstanceUid !== uid) {
      return Response.json({ error: "この要求ID は別の削除に使われています" }, { status: 409 });
    }
    if (o.outcome === "success" || o.outcome === "failed") return priorResponse(session, uid, requestId, rows, true);
    const still = await deletedStudyStillPresent(getBackend(), rows, uid);
    if (still) {
      // 先の DELETE が止まった・終わったと言える証拠が無い（遅れて消えることがある）。確定させず、記録にも足さない
      return Response.json(
        { requestId, outcome: "unknown", studyPresent: true, error: "検査はまだサーバーに残っています。前回の削除が完了したかは不明です" },
        { status: 202 },
      );
    }
    await audit(session, {
      action: "delete",
      outcome: "success",
      patientId: rows.find((r) => r.patientId)?.patientId ?? null,
      studyInstanceUid: uid,
      detail: { requestId, phase: "reconcile", studyPresent: false },
    });
    return Response.json({ requestId, outcome: "deleted", reconciled: true });
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
  const confirmToken = signDeleteConfirm(
    { orthancId: info.orthancId, studyInstanceUid: info.studyInstanceUid, patientId: info.patientId, version: info.version, actorId: session.actorId },
    getConfig().sessionSecret,
  );
  return Response.json({
    confirmToken,
    patientId: info.patientId,
    patientName: name.name,
    patientKana: name.kana,
    patientBirthDate: info.patientBirthDate,
    patientSex: info.patientSex,
    studyDate: info.studyDate,
    seriesCount: series.length,
    instanceCount: series.reduce((n, s) => n + (s.instanceCount ?? 0), 0),
  });
}

function unknownResponse(requestId: string): Response {
  return Response.json(
    { requestId, outcome: "unknown", error: "削除結果を確認できません。再実行せずに状態を確認してください" },
    { status: 202 },
  );
}

function priorResponse(session: Session, uid: string, requestId: string, rows: readonly RequestRow[], allowReconciler = false): Response {
  const o = requestOutcome(rows);
  const actorOk = o.actorId === session.actorId || (allowReconciler && can(session.role, "pacs.reconcile"));
  if (!actorOk || o.studyInstanceUid !== uid) {
    return Response.json({ error: "この要求ID は別の削除に使われています" }, { status: 409 });
  }
  if (o.outcome === "success") return Response.json({ requestId, outcome: "deleted", repeated: true });
  if (o.outcome === "failed") return Response.json({ requestId, outcome: "failed", repeated: true });
  return Response.json({ requestId, outcome: "unknown", repeated: true }, { status: 202 });
}
