import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { can } from "@/lib/auth/roles";
import { audit, auditIf, requirePermission, requireSession, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendUnknownError, type Backend } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { checkCorrectionValues, correctionScope, normalizeCorrectionValues, type CorrectionValues } from "@/lib/correction-fields";
import { getDb } from "@/lib/db";
import { enqueue, history, QueueFull, reconcile, unresolved, writeAudit, type AuditRow } from "@/lib/keep-uid-write";
import { assertWriteAllowed, isRequestId, isUnresolved, openModifyConfirm, requestOutcome, rowsOfRequest, type RequestRow } from "@/lib/pacs-ops";
import { todayIn } from "@/lib/study-filter";
import { applyAttributeCorrection,checkContent, CorrectionRefused, newStudyUid, readSnapshot, reassignMemory, waitJob, type CorrectionSnapshot } from "@/lib/study-correction";
import { visible } from "../../../../../../hl7-receiver/visible";
import { assertReauth, contentGroup, contentUnresolved, Kind, OrthancId, pendingAttribute, pendingContent, refuse, refusedBy, requestDetail, UNRESOLVED, Values } from "./shared";

// 患者・検査の値の修正（docs/spec.md の 3.5。段 6。openspec/changes/add-study-value-correction）。一般と管理者（study.modify）、
// 理由を必須、再認証の後（AUTH_MODE=local）。書き込みの操作の共通の決まり（3.5）を通す：CSRF・画面のロック・検証モードの止め・
// 呼ぶ前の記録（記録できなければ呼ばない）・呼んだ後の記録・要求の ID で二度流さない・答えが分からなければ結果不明。
// - 属性の訂正（kind attribute）：患者 ID・氏名・生年月日・性別・受付番号を、Study・Series・SOP Instance UID を保って直す。
//   HL7 による患者情報の更新と同じ部品（src/lib/keep-uid-write.ts）を使い、同じ列で 1 つずつ流す。どちらかの結果不明・
//   部分反映が残るあいだは書き換えない。氏名・生年月日・性別は同じ患者 ID の全部の検査、患者 ID の付け替えと受付番号は選んだ1検査。
// - 中身の訂正（kind content）：検査日・検査名を直した、新しい UID の検査を作る。元の検査は必ず残す（消すのは削除の操作）。
// - 確かめの画面（./preview）で見せた検査と値は token に結び、書き換える直前に、いまの状態が同じでなければ 409 で断る。

type Context = { params: Promise<{ uid: string }> };

/** 理由の長さの上限（文字。削除と同じ） */
const REASON_MAX = 500;

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求ID が正しくありません"),
  kind: Kind,
  values: Values,
  /** 修正理由（必須。形は役割の確かめの後に確かめ、断ったことを記録に残す） */
  reason: z.string().max(4 * REASON_MAX).optional(),
  /** 確かめの画面（./preview）が返した token */
  confirmToken: z.string().min(1).max(2048),
  /** 元の検査を消す指定。どの役割でも断る（元の検査を消すのは削除の操作） */
  deleteSource: z.boolean().optional(),
  /** 同じ UID の検査が複数あるときに選んだ検査（確かめの画面で選んだもの。token の中のものと同じであること） */
  orthancId: OrthancId.optional(),
});


export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const body = await readJson(request, Body, 16_384);
    const { requestId, kind, confirmToken } = body;
    const posted = body.values as CorrectionValues;
    const denied ={ action: "modify" as const, studyInstanceUid: uid, detail: { requestId, kind } };
    await requirePermission(session, "study.modify", denied);
    await assertWriteAllowed(session, denied);
    const reason = (body.reason ?? "").trim();
    if (reason.length === 0) return refuse(session, uid, requestId, 400, "no_reason", "修正理由を入力してください");
    if (reason.length > REASON_MAX) return refuse(session, uid, requestId, 400, "reason_too_long", `修正理由は ${REASON_MAX} 文字までです`);
    if (body.deleteSource) {
      return refuse(session, uid, requestId, 400, "delete_source", "元の検査は残します。元の検査を消すときは、削除の操作を使ってください");
    }
    // 生年月日は画面と同じ読み取りで YYYYMMDD にそろえる（和暦の入力も受ける。今日はサーバーの時間帯の今日）
    const normalized = normalizeCorrectionValues(posted, todayIn(getConfig().timeZone));
    if ("problem" in normalized) {
      return refuse(session, uid, requestId, 400, "invalid", normalized.problem.message, { field: normalized.problem.field });
    }
    const { values } = normalized;
    const problem = checkCorrectionValues(values);
    if (problem) return refuse(session, uid, requestId, 400, "invalid", problem.message, { field: problem.field });
    const decided = correctionScope(kind, values);
    if ("problem" in decided) return refuse(session, uid, requestId, 400, "invalid", decided.problem.message);
    await assertReauth(session);

    const db = await getDb();
    const prior = await rowsOfRequest(db, "modify", requestId, uid);
    if (requestOutcome(prior).phase !== "none") return priorResponse(session, uid, requestId, prior);

    // 確かめの画面の token：この利用者が、この UID の検査で、同じ種類と範囲で、期限の中に開いたもの
    const shown = openModifyConfirm(confirmToken, getConfig().sessionSecret);
    if (!shown || shown.actorId !== session.actorId || shown.studyInstanceUid !== uid || shown.kind !== kind || shown.scope !== decided.scope
      || (body.orthancId !== undefined && body.orthancId !== shown.orthancId)) {
      return refuse(session, uid, requestId, 409, "confirm_invalid", "確認画面の有効期限が切れました。もう一度確認してから修正してください");
    }
    const backend = getBackend();
    if (kind === "attribute") {
      const settings = await backend.keepUidSettings();
      if (!settings.overwriteInstances || (decided.scope === "reassign" && !settings.lockMetadata)) {
        return refuse(session, uid, requestId, 409, "orthanc_config", "画像サーバーの設定が足りないため、患者情報修正はできません（OverwriteInstances・UserMetadata）");
      }
    }
    const run = { session, uid, requestId, kind, values, reason: visible(reason), shown, backend, db };
    try {
      return await enqueue(() => (kind === "attribute" ? runAttribute(run) : runContent(run)));
    } catch (e) {
      if (e instanceof QueueFull) return Response.json({ error: "処理が混み合っています。時間をおいて、やり直してください" }, { status: 503 });
      throw e;
    }
  } catch (error) {
    return errorResponse(error);
  }
}

interface Run {
  session: Session;
  uid: string;
  requestId: string;
  kind: "attribute" | "content";
  values: CorrectionValues;
  reason: string;
  shown: { orthancId: string; state: string };
  backend: Backend;
  db: Awaited<ReturnType<typeof getDb>>;
}

/** 列の中で、いまの状態を読み直し、確かめの画面で見せた状態と同じかを照らす */
async function snapshotNow(r: Run): Promise<CorrectionSnapshot | Response> {
  let snap: CorrectionSnapshot;
  try {
    snap = await readSnapshot(r.backend, r.uid, r.kind, r.values, r.shown.orthancId);
  } catch (e) {
    if (e instanceof CorrectionRefused) return refusedBy(r.session, r.uid, r.requestId, e);
    throw e;
  }
  if (snap.state !== r.shown.state) {
    return refuse(r.session, r.uid, r.requestId, 409, "changed", "確認の後に検査が更新されました。もう一度確認してください", {}, snap.selected.instances[0]!.PatientID);
  }
  return snap;
}

/** 「求めた」の行を、同じ要求の ID の行がまだ無いときだけ足す（記録できなければ Orthanc を呼ばない） */
async function begin(r: Run, snap: CorrectionSnapshot, detail: Record<string, unknown>): Promise<boolean> {
  return auditIf<boolean>(r.session, async (tx) => {
    if (requestOutcome(await rowsOfRequest(tx, "modify", r.requestId, r.uid)).phase !== "none") return { value: false, fields: null };
    return {
      value: true,
      fields: {
        action: "modify",
        outcome: "success",
        patientId: snap.selected.instances[0]!.PatientID,
        studyInstanceUid: r.uid,
        detail: {
          requestId: r.requestId,
          phase: "request",
          kind: r.kind,
          scope: snap.scope,
          reason: r.reason,
          // 直す項目ごとの前と後の値（選んだ検査）。氏名は「=」で区切った組の全部
          fields: snap.fields,
          StudyInstanceUID: r.uid,
          orthancId: snap.selected.orthancId,
          ...detail,
        },
      },
    };
  });
}

async function runAttribute(r: Run): Promise<Response> {
  // HL7 の書き換えと同じく、結果不明・部分反映の書き換えを先に照らし、残っていれば書き換えない
  const rows = [...await history()];
  if (!await reconcile(r.backend, rows, writeAudit) || (await pendingContent(r.db, r.uid)).length > 0) {
    return refuse(r.session, r.uid, r.requestId, 409, "unresolved", UNRESOLVED);
  }
  const snap = await snapshotNow(r);
  if (snap instanceof Response) return snap;
  // 同じ患者のほかの検査にも、結果不明・部分反映の中身の訂正が残っていれば書き換えない（写しを作っている最中かもしれない）
  for (const st of snap.studies) {
    if ((await pendingContent(r.db, st.info.studyInstanceUid)).length > 0) return refuse(r.session, r.uid, r.requestId, 409, "unresolved", UNRESOLVED);
  }
  const pick = (i: (typeof snap.selected.instances)[number]) =>
    ({ PatientID: i.PatientID, PatientName: i.PatientName, PatientBirthDate: i.PatientBirthDate, PatientSex: i.PatientSex, AccessionNumber: i.AccessionNumber });
  const started = await begin(r, snap, {
    // 書き換える検査ごとの前の値（戻すときは、この値への属性の訂正をもう一度行う）
    studies: snap.studies.map((st) => ({ StudyInstanceUID: st.info.studyInstanceUid, orthancId: st.orthancId, instances: st.instances.length, before: pick(st.instances[0]!) })),
    ...(snap.target ? { target: snap.target } : {}),
    // 付け替えの覚え（受理の時刻を除く）。要求全体の結果を後から決めるときに、見回りの覚えとして結果の行に写す
    ...(reassignMemory(snap) ? { rememberDraft: reassignMemory(snap) } : {}),
  });
  if (!started) return priorResponse(r.session, r.uid, r.requestId, await rowsOfRequest(r.db, "modify", r.requestId, r.uid));
  // 「求めた」の行の監査の順（付け替えの覚えの前後を、時計でなくこの順で決める。HL7 の見回り）
  const requestSeq = requestSeqOf(await rowsOfRequest(r.db, "modify", r.requestId, r.uid));

  // 書き換えの経過は、HL7 と同じ部品の行（event・writeId）を modify の行として残す
  const row: AuditRow = (event, outcome, detail = {}, patientId, studyInstanceUid) =>
    audit(r.session, { action: "modify", outcome, patientId, studyInstanceUid, detail: { requestId: r.requestId, event, ...detail } });
  const { outcome, count, total, writes, partial, message, remember } = await applyAttributeCorrection(r.backend, snap, r.requestId, row);
  const p = snap.selected.instances[0]!;
  try {
    await audit(r.session, {
      action: "modify",
      outcome,
      patientId: snap.scope === "reassign" && outcome === "success" ? snap.target!.patientId : p.PatientID,
      studyInstanceUid: r.uid,
      detail: {
        requestId: r.requestId,
        phase: "result",
        kind: r.kind,
        scope: snap.scope,
        count,
        total,
        writes,
        ...(partial ? { partial: true } : {}),
        ...(message ? { message: visible(message) } : {}),
        // 属性の訂正では UID は変わらない
        newStudyInstanceUid: r.uid,
        ...(remember ? { remember: { ...remember, ...(requestSeq !== undefined ? { requestSeq } : {}) } } : {}),
      },
    });
  } catch {
    console.error(JSON.stringify({ event: "modify_result_not_recorded", requestId: r.requestId }));
    return unknownResponse(r.requestId);
  }
  if (outcome === "unknown") return unknownResponse(r.requestId);
  if (outcome === "failed") {
    return Response.json(
      partial
        ? { requestId: r.requestId, outcome: "partial", count, total, error: "一部の画像だけが修正されました。管理者が確認するまで、修正はできません" }
        : { requestId: r.requestId, outcome: "failed", count, total, error: `修正できませんでした（${message ?? ""}）` },
      { status: 502 },
    );
  }
  return Response.json({ requestId: r.requestId, outcome: "modified", count, total, studyInstanceUid: r.uid });
}

async function runContent(r: Run): Promise<Response> {
  const rows = [...await history()];
  await reconcile(r.backend, rows, writeAudit);
  if (unresolved(rows).some((d) => d.StudyInstanceUID === r.uid || d.group?.includes(r.uid)) || (await pendingContent(r.db, r.uid)).length > 0) {
    return refuse(r.session, r.uid, r.requestId, 409, "unresolved", UNRESOLVED);
  }
  const snap = await snapshotNow(r);
  if (snap instanceof Response) return snap;
  const newUid = newStudyUid();
  const after = Object.fromEntries(Object.entries(snap.fields).map(([f, v]) => [f, v.after]));
  const instanceCount = snap.selected.instances.length;
  // 中身の訂正も、書き換えの部品の組（event group）として残す。結果不明・部分反映のあいだは、HL7 の受信・見回りと画面の
  // 属性の訂正が、書き換えの部品の unresolved で止まる（Orthanc が元の検査を写している最中に、元を書き換えない）
  const writeId = randomUUID();
  const started = await begin(r, snap, {
    newStudyInstanceUid: newUid,
    instanceCount,
    ...contentGroup(writeId, r.requestId, snap.selected.orthancId, r.uid),
  });
  if (!started) return priorResponse(r.session, r.uid, r.requestId, await rowsOfRequest(r.db, "modify", r.requestId, r.uid));
  const patientId = snap.selected.instances[0]!.PatientID;
  const result = (outcome: "success" | "failed" | "unknown", extra: Record<string, unknown> = {}) =>
    audit(r.session, {
      action: "modify",
      outcome,
      patientId,
      studyInstanceUid: r.uid,
      detail: { requestId: r.requestId, phase: "result", kind: "content", newStudyInstanceUid: newUid, event: "result", writeId, ...extra },
    });

  let jobId: string;
  try {
    ({ jobId } = await r.backend.modifyStudyNewUid(snap.selected.orthancId, { ...after, StudyInstanceUID: newUid }));
  } catch (e) {
    if (e instanceof BackendUnknownError) {
      await result("unknown").catch(() => console.error(JSON.stringify({ event: "modify_result_not_recorded", requestId: r.requestId })));
      return unknownResponse(r.requestId);
    }
    const message = e instanceof Error ? e.message.slice(0, 200) : "";
    await result("failed", { message: visible(message) });
    return Response.json({ requestId: r.requestId, outcome: "failed", error: `修正できませんでした（${message}）` }, { status: 502 });
  }
  await audit(r.session, {
    action: "modify",
    outcome: "success",
    patientId,
    studyInstanceUid: r.uid,
    detail: { requestId: r.requestId, phase: "dispatch", kind: "content", jobId },
  });
  let state: "Success" | "Failure";
  try {
    state = await waitJob(r.backend, jobId);
  } catch {
    await result("unknown").catch(() => console.error(JSON.stringify({ event: "modify_result_not_recorded", requestId: r.requestId })));
    return unknownResponse(r.requestId);
  }
  let check;
  try {
    check = await checkContent(r.backend, { orthancId: snap.selected.orthancId, StudyInstanceUID: r.uid, newStudyInstanceUid: newUid, after, instanceCount });
  } catch {
    await result("unknown", { state }).catch(() => undefined);
    return unknownResponse(r.requestId);
  }
  const success = state === "Success" && check.matches && check.sourceKept;
  // 作られた検査が合わない・元が残っていないときは、部分反映として人に見せる（照らし合わせでは自動で解かない）
  const partial = !success && (check.newOrthancId !== null || !check.sourceKept);
  await result(success ? "success" : "failed", { state, ...check, ...(partial ? { partial: true } : {}) });
  if (!success) {
    return Response.json(
      { requestId: r.requestId, outcome: partial ? "partial" : "failed", error: partial ? "修正した検査を確認できませんでした。管理者に確認を依頼してください" : "修正できませんでした" },
      { status: 502 },
    );
  }
  return Response.json({ requestId: r.requestId, outcome: "created", studyInstanceUid: r.uid, newStudyInstanceUid: newUid });
}

/**
 * GET ?requestId=… ：同じ要求のいまの結果。中身の訂正の結果不明は、作るはずだった検査（BFF が決めた StudyInstanceUID）を
 * Orthanc で探して照らす。作られて値が合えば成功、無くて仕事が失敗か見つからなければ失敗として記録に足す。
 * 属性の訂正は、書き換えごとの結果（HL7 と同じ部品の行）を読み、結果不明・部分反映の書き換えの ID を返す（管理者が /api/hl7/resolve で解く）
 */
export async function GET(request: Request, { params }: Context) {
  try {
    const session = await requireSession();
    const uid = studyUidParam((await params).uid);
    const requestId = new URL(request.url).searchParams.get("requestId");
    if (requestId === null) return await pending(session, uid);
    if (!isRequestId(requestId)) return Response.json({ error: "要求ID が正しくありません" }, { status: 400 });
    await requirePermission(session, "study.modify", { action: "modify", studyInstanceUid: uid, detail: { requestId, via: "status" } });
    const db = await getDb();
    const rows = await rowsOfRequest(db, "modify", requestId, uid);
    const o = requestOutcome(rows);
    if (o.phase === "none") return Response.json({ requestId, outcome: "none" });
    if ((o.actorId !== session.actorId && !can(session.role, "pacs.reconcile")) || o.studyInstanceUid !== uid) {
      return Response.json({ error: "この要求ID は別の修正に使われています" }, { status: 409 });
    }
    const d = requestDetail(rows);
    if (d.kind === "attribute") {
      const pending = unresolved(await history()).map((w) => w.writeId).filter((id) => writesOf(rows).includes(id));
      if (pending.length) return Response.json({ requestId, outcome: "unknown", unresolvedWriteIds: pending });
      if (!isUnresolved(o)) return Response.json({ requestId, outcome: o.outcome === "success" ? "modified" : o.outcome ?? "unknown", unresolvedWriteIds: [] });
      // 要求全体の結果が無い・結果不明のまま（書き換えの後、結果を記録する前に止まった・記録に失敗した・書き換えの結果不明を後で
      // 照らし合わせが解いた）。列の中で、書き換えごとの記録から決めて足す
      return await enqueue(() => settleAttribute(session, uid, requestId));
    }
    // 部分反映（作られた検査が合わない・元が残っていない）は、自動では解かない。管理者が ./resolve で確かめて解く
    if (contentUnresolved(rows) && (o.outcome === "success" || o.outcome === "failed")) {
      return Response.json({ requestId, outcome: "partial", error: "修正した検査を確認できませんでした。管理者に確認を依頼してください" }, { status: 202 });
    }
    if (o.outcome === "success" || o.outcome === "failed") return priorResponse(session, uid, requestId, rows, true);
    // 結果不明の照らし合わせは、書き換えと同じ列の中で行う（実行中の要求が結果を書き終えるのを待ち、書いた結果を上書きしない）
    return await enqueue(() => reconcileContent(session, uid, requestId));
  } catch (error) {
    if (error instanceof QueueFull) return Response.json({ error: "処理が混み合っています。時間をおいて、やり直してください" }, { status: 503 });
    return errorResponse(error);
  }
}

/**
 * 結果不明の中身の訂正を照らす（列の中で呼ぶ）。仕事が Success で終わったと読め、作るはずだった検査が値・画像の数・新しい UID の
 * そろった形で1件あり、元の検査が残っていれば成功。作られておらず、仕事が Failure か Orthanc に無いと読めたときだけ失敗。
 * どちらとも言えない（仕事の ID が分からない・仕事がまだ動いている・作られた検査が合わない）ときは確定しない（管理者が ./resolve で解く）
 */
async function reconcileContent(session: Session, uid: string, requestId: string): Promise<Response> {
  const db = await getDb();
  const rows = await rowsOfRequest(db, "modify", requestId, uid);
  const o = requestOutcome(rows);
  if (!isUnresolved(o)) {
    if (contentUnresolved(rows)) {
      return Response.json({ requestId, outcome: "partial", error: "修正した検査を確認できませんでした。管理者に確認を依頼してください" }, { status: 202 });
    }
    return priorResponse(session, uid, requestId, rows, true);
  }
  const d = requestDetail(rows);
  const undecided = (studyCreated: boolean | null) =>
    Response.json({ requestId, outcome: "unknown", studyCreated, error: "修正の結果を確認できません。管理者に確認を依頼してください" }, { status: 202 });
  if (!o.jobId) return undecided(null);
  const backend = getBackend();
  // 仕事の終わりを先に確かめてから、作られた検査を読む（写している最中の検査を、そろったと読まない）
  const job = await backend.jobStatus(o.jobId);
  if (job !== null && job.state !== "Success" && job.state !== "Failure") return undecided(null);
  const newUid = typeof d.newStudyInstanceUid === "string" ? d.newStudyInstanceUid : "";
  const fields = (d.fields ?? {}) as Record<string, { after?: unknown }>;
  const check = await checkContent(backend, {
    orthancId: String(d.orthancId ?? ""),
    StudyInstanceUID: uid,
    newStudyInstanceUid: newUid,
    after: Object.fromEntries(Object.entries(fields).map(([f, v]) => [f, String(v?.after ?? "")])),
    instanceCount: Number(d.instanceCount ?? -1),
  });
  const settled = job?.state === "Success" && check.matches && check.sourceKept
    ? "success"
    : (job === null || job.state === "Failure") && check.newOrthancId === null ? "failed" : null;
  if (!settled) return undecided(check.newOrthancId !== null);
  const written = await auditIf<boolean>(session, async (tx) => {
    // 記録の並びの中で、まだ結果不明のままかを確かめてから足す（ほかで解かれた・結果が書かれた後は上書きしない）
    const now = await rowsOfRequest(tx, "modify", requestId, uid);
    if (!isUnresolved(requestOutcome(now)) || !contentUnresolved(now)) return { value: false, fields: null };
    return {
      value: true,
      fields: {
        action: "modify",
        outcome: settled,
        patientId: now.find((r) => r.patientId)?.patientId ?? null,
        studyInstanceUid: uid,
        detail: {
          requestId,
          phase: "reconcile",
          kind: "content",
          ...check,
          jobState: job?.state ?? null,
          // 書き換えの部品の組も、同じ行で解く
          ...(typeof d.writeId === "string" ? { event: "reconcile", writeId: d.writeId, partial: false } : {}),
        },
      },
    };
  });
  if (!written) return priorResponse(session, uid, requestId, await rowsOfRequest(db, "modify", requestId, uid), true);
  return Response.json({ requestId, outcome: settled === "success" ? "created" : "failed", reconciled: true, ...(settled === "success" ? { newStudyInstanceUid: newUid } : {}) });
}

/** 要求の「求めた」の行の監査の順（seq）。無ければ undefined */
function requestSeqOf(rows: readonly { seq?: number; detail: string | null }[]): number | undefined {
  return rows.find((r) => requestDetail([r]).phase === "request")?.seq;
}

/** 要求の記録の行のうち、書き換えの部品の行（検査ごとの書き換えと、検査をまとめた組）の ID */
function writesOf(rows: readonly { detail: string | null }[]): string[] {
  return rows.flatMap((row) => {
    try {
      const x = JSON.parse(row.detail ?? "{}") as { event?: unknown; writeId?: unknown };
      return (x.event === "request" || x.event === "group") && typeof x.writeId === "string" ? [x.writeId] : [];
    } catch {
      return [];
    }
  });
}

/**
 * 要求全体の結果の行が無い属性の訂正を、書き換えごとの記録から決めて足す（列の中で呼ぶ。実行中の要求とは重ならない）。
 * 解いていない書き換えが残れば決めない。書き換えが1つも無ければ（書き換える前に止まった）何も変わっていないので失敗。
 * 書き換えの全部が成功（照らし合わせの成功を含む）なら成功、それ以外は失敗
 */
async function settleAttribute(session: Session, uid: string, requestId: string): Promise<Response> {
  const db = await getDb();
  const rows = await rowsOfRequest(db, "modify", requestId, uid);
  const o = requestOutcome(rows);
  if (!isUnresolved(o)) return Response.json({ requestId, outcome: o.outcome === "success" ? "modified" : o.outcome ?? "unknown", unresolvedWriteIds: [] });
  const writes = writesOf(rows);
  const all = await history();
  const pending = unresolved(all).map((w) => w.writeId).filter((id) => writes.includes(id));
  if (pending.length) return Response.json({ requestId, outcome: "unknown", unresolvedWriteIds: pending });
  const lastOf = (writeId: string) => all.filter((r) => r.detail?.writeId === writeId && ["result", "reconcile"].includes(String(r.detail?.event))).at(-1);
  const settled = writes.length > 0 && writes.every((id) => lastOf(id)?.outcome === "success") ? "success" : "failed";
  const draft = requestDetail(rows).rememberDraft as Record<string, unknown> | undefined;
  const written = await auditIf<boolean>(session, async (tx) => {
    if (!isUnresolved(requestOutcome(await rowsOfRequest(tx, "modify", requestId, uid)))) return { value: false, fields: null };
    return {
      value: true,
      fields: {
        action: "modify",
        outcome: settled,
        patientId: rows.find((r) => r.patientId)?.patientId ?? null,
        studyInstanceUid: uid,
        detail: {
          requestId,
          phase: "reconcile",
          kind: "attribute",
          writes,
          ...(writes.length === 0 ? { reason: "書き換える前に止まった" } : {}),
          // 付け替えが成功していれば、見回りの覚えを残す。期限は「求めた」の時刻から数える（照会のたびに延ばさない）
          ...(settled === "success" && draft && o.requestedAt
            ? { remember: { ...draft, at: o.requestedAt.toISOString(), ...(requestSeqOf(rows) !== undefined ? { requestSeq: requestSeqOf(rows) } : {}) } }
            : {}),
        },
      },
    };
  });
  const now = requestOutcome(await rowsOfRequest(db, "modify", requestId, uid));
  return Response.json({ requestId, outcome: now.outcome === "success" ? "modified" : now.outcome ?? "unknown", unresolvedWriteIds: [], ...(written ? { reconciled: true } : {}) });
}

/**
 * GET（requestId なし）：この検査の、管理者の確かめを待っている値の修正（結果不明・部分反映）。修正の窓を開き直したとき・
 * 頁を読み直したときに、状態の確認と解除の道へ戻すため。本人の要求のほか、照らし合わせの役割（管理者）なら全部を返す。
 * 書き換えの ID は、HL7 の書き換えのもの（この検査に当たるもの）も含める（管理者が /api/hl7/resolve で解く）
 */
async function pending(session: Session, uid: string): Promise<Response> {
  await requirePermission(session, "study.modify", { action: "modify", studyInstanceUid: uid, detail: { via: "pending" } });
  const reconciler = can(session.role, "pacs.reconcile");
  const rows = await history();
  const out: { requestId: string | null; kind: "attribute" | "content" | "hl7"; writeIds: string[] }[] = [];
  for (const d of unresolved(rows)) {
    if (d.StudyInstanceUID !== uid && !d.group?.includes(uid)) continue;
    if ((d as { content?: unknown }).content === true) continue;
    const head = rows.find((r) => (r.detail?.event === "request" || r.detail?.event === "group") && r.detail?.writeId === d.writeId);
    const kind = head?.action === "modify" ? "attribute" : "hl7";
    if (kind === "attribute" && head?.actorId !== session.actorId && !reconciler) continue;
    if (kind === "hl7" && !reconciler) continue;
    const requestId = kind === "attribute" ? d.messageId : null;
    const same = out.find((p) => p.requestId !== null && p.requestId === requestId);
    if (same) same.writeIds.push(d.writeId);
    else out.push({ requestId, kind, writeIds: [d.writeId] });
  }
  const db = await getDb();
  // 書き換えはどれも解けたが、要求全体の結果がまだ無い・結果不明の属性の訂正（照会で書き換えごとの記録から決める）
  for (const id of await pendingAttribute(db, uid)) {
    if (out.some((p) => p.requestId === id)) continue;
    const o = requestOutcome(await rowsOfRequest(db, "modify", id, uid));
    if (o.actorId === session.actorId || reconciler) out.push({ requestId: id, kind: "attribute", writeIds: [] });
  }
  for (const id of await pendingContent(db, uid)) {
    const o = requestOutcome(await rowsOfRequest(db, "modify", id, uid));
    if (o.actorId === session.actorId || reconciler) out.push({ requestId: id, kind: "content", writeIds: [] });
  }
  return Response.json({ pending: out });
}

function unknownResponse(requestId: string): Response {
  return Response.json({ requestId, outcome: "unknown", error: "修正の結果を確認できません。再実行せずに状態を確認してください" }, { status: 202 });
}

function priorResponse(session: Session, uid: string, requestId: string, rows: readonly RequestRow[], allowReconciler = false): Response {
  const o = requestOutcome(rows);
  const actorOk = o.actorId === session.actorId || (allowReconciler && can(session.role, "pacs.reconcile"));
  if (!actorOk || o.studyInstanceUid !== uid) {
    return Response.json({ error: "この要求ID は別の修正に使われています" }, { status: 409 });
  }
  if (o.outcome === "success") return Response.json({ requestId, outcome: requestDetail(rows).kind === "content" ? "created" : "modified", repeated: true });
  if (o.outcome === "failed") return Response.json({ requestId, outcome: "failed", repeated: true });
  return Response.json({ requestId, outcome: "unknown", repeated: true }, { status: 202 });
}
