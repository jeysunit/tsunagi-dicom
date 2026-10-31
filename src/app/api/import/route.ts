import { createHash } from "node:crypto";
import { RequestError, checkedScreenWrite } from "@/lib/api/auth-route";
import { readLimitedBytes } from "@/lib/api/body";
import { errorResponse } from "@/lib/api/respond";
import type { AuditAction, Tx } from "@/lib/audit";
import { audit, auditIf, requirePermission, requireSession, type Session } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError, BackendUnknownError, type Backend } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";
import { getDb, type Db } from "@/lib/db";
import { DicomFileError, readDicomFileHeader, type DicomFileHeader } from "@/lib/dicom-file";
import { assertWriteAllowed, clip, isRequestId, isUnresolved, requestOutcome, rowsOfRequest, unresolvedRequests, type RequestRow } from "@/lib/pacs-ops";
import { pendingAttribute, pendingContent } from "../studies/[uid]/modify/shared";

// インポート（docs/spec.md の 3.5 の「取り込み」。段 6）。DICOM のファイル 1 つを、本文のバイトのまま受けて Orthanc へ入れる
// （POST /instances）。画面は複数のファイルを 1 つずつ送る（BFF が持つのは 1 つのファイルの分のメモリだけ）。
// 書き込みの操作の共通の決まり（3.5）を通す：役割（study.import）・CSRF・検証モードの書き込みの止め・呼ぶ前の記録
// （記録できなければ呼ばない）・呼んだ後の記録・要求の ID で二度流さない・答えが分からなければ結果不明。
// Orthanc へ渡す前に、大きさの上限（IMPORT_MAX_MB）と DICOM のファイルの形（"DICM"・File Meta Information・タグの並び）を
// 確かめて断る。
// もうある画像・検査は取り込まない（取り込み直しで、値の修正の確かめ（理由・再認証・未解決の要求）を通らずに中身を置き換えない）：
// - 同じ SOP Instance UID の画像が Orthanc にあれば断る。
// - 同じ StudyInstanceUID の検査が Orthanc にあれば断る。例外は、同じ利用者が同じ組（x-import-batch）で先に入れた検査に、
//   同じ患者 ID の画像を続けて入れるときだけ（検査の 2 枚目からの画像）。
// - 同じ検査に、まだ結果の分からない取り込み・削除・値の修正（HL7 の更新を含む書き換え）があれば断る。
// 取り込んだ後に、Orthanc が保存した値（画像の親の検査の StudyInstanceUID と患者 ID）を読み、ファイルから読んだ値と違えば、
// 入れた画像を消して断る（消す前に記録し、消した結果も記録する）。合ったときだけ、インポートの印（Orthanc のラベル）を付ける。
// 結果不明は、GET（?requestId=…）で SOP Instance UID を引き当て、同じ照らしをする。照らして値が違っても、GET では消さない
// （見つけた画像が、この要求の入れた画像とは言えないため）。結果不明のまま管理者の確かめに残す。
// 引き当てと「求めた」の記録の間に、並んで届いた別の要求の ID の同じ画像・検査の取り込みは、記録の並びの中で見つけて断る。

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

/** 患者 ID（LO）を比べる形。前後の空白は値の意味を持たない（PS3.5 6.2 の LO） */
const samePatientId = (a: string, b: string) => a.replace(/^ +| +$/g, "") === b.replace(/^ +| +$/g, "");

const REIMPORT = "同じ画像または検査がもう画像サーバーにあります。取り込み直しはできません（値を直すときは患者情報修正を使ってください）";
const UNRESOLVED = "この検査に、結果の確認されていない取り込み・削除・修正があります。先に状態を確認してください";

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
    const refuse = async (status: number, reason: string, error: string, extra: Record<string, unknown> = {}) => {
      await audit(session, { action: "import", outcome: "denied", patientId, studyInstanceUid: uid, detail: { ...detail, reason, ...extra } });
      return Response.json({ requestId, error, ...extra }, { status });
    };

    const db = await getDb();
    const prior = await rowsOfRequest(db, "import", requestId, uid);
    if (requestOutcome(prior).phase !== "none") return priorResponse(session, requestId, uid, prior, same);

    // 患者 ID を字に直せなかった（文字の集合が ISO_IR 192・ISO_IR 100 でない、ASCII の外の字）ファイルは、Orthanc の読む値と
    // 照らせないので、渡す前に断る（LO はバックスラッシュを持てないので、`\xNN` の形はこの場合だけ）
    if (dicom.patientId.includes("\\x")) {
      return refuse(400, "unsupported_charset", "患者IDの文字コードを読めないため、取り込めません");
    }

    // もうある画像・検査は取り込まない（取り込み直しで、値の修正の確かめを通らずに中身を置き換えない）
    const backend = getBackend();
    // 引き当てる前の記録の末尾。引き当ての後に始まった、同じ画像・検査のほかの取り込みを、記録の並びの中で見つける
    const checkedAt = (await db.auditLog.findFirst({ orderBy: { seq: "desc" }, select: { seq: true } }))?.seq ?? 0;
    const exists = await existingTarget(backend, db, session, dicom, base.batch?.id);
    if (exists) return refuse(409, exists.reason, REIMPORT, exists.orthancStudyId ? { orthancStudyId: exists.orthancStudyId } : {});

    // 呼ぶ前に「求めた」を記録する。同じ要求の ID が並んで届いたときは、先の1つだけを通す。記録の並びの中で、
    // 引き当ての後に同じ画像・検査のほかの取り込みが始まっていないか（並んで届いた別の要求の ID の取り込み）と、
    // 同じ検査に結果の分からない取り込み・削除・修正が無いかを確かめて断る
    type Begin =
      | { kind: "first" }
      | { kind: "repeated" }
      | { kind: "pending"; pending: string[] }
      | { kind: "raced"; reason: "instance_exists" | "study_exists" };
    const begin = await auditIf<Begin>(session, async (tx) => {
      if (requestOutcome(await rowsOfRequest(tx, "import", requestId, uid)).phase !== "none") return { value: { kind: "repeated" }, fields: null };
      const raced = await startedSince(tx, session, checkedAt, requestId, dicom, base.batch?.id);
      if (raced) {
        return {
          value: { kind: "raced", reason: raced },
          fields: { action: "import", outcome: "denied", patientId, studyInstanceUid: uid, detail: { ...detail, reason: raced, raced: true } },
        };
      }
      const pending = await pendingOnStudy(tx, uid);
      if (pending.length > 0) {
        return {
          value: { kind: "pending", pending },
          fields: { action: "import", outcome: "denied", patientId, studyInstanceUid: uid, detail: { ...detail, reason: "unresolved", pending } },
        };
      }
      return {
        value: { kind: "first" },
        fields: { action: "import", outcome: "success", patientId, studyInstanceUid: uid, detail: { ...detail, phase: "request" } },
      };
    });
    if (begin.kind === "repeated") return priorResponse(session, requestId, uid, await rowsOfRequest(db, "import", requestId, uid), same);
    if (begin.kind === "pending") return Response.json({ requestId, error: UNRESOLVED, pending: begin.pending }, { status: 409 });
    if (begin.kind === "raced") return Response.json({ requestId, error: REIMPORT }, { status: 409 });

    const result = (outcome: "success" | "failed" | "unknown", extra: Record<string, unknown> = {}) =>
      audit(session, { action: "import", outcome, patientId, studyInstanceUid: uid, detail: { ...detail, phase: "result", ...extra } });

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

    // Orthanc が保存した値を読み、ファイルから読んだ値と照らす。読めなければ結果不明（状態の確認で照らし直す）
    const checked = await checkStored(backend, stored, {
      studyInstanceUid: uid,
      sopInstanceUid: dicom.sopInstanceUid,
      patientId: dicom.patientId,
      compare: samePatientId,
    });
    if (checked.kind === "unreadable") {
      await result("unknown", { status: stored.status, orthancStudyId: stored.orthancStudyId, reason: "verify_failed" }).catch(() =>
        logRecordFailure(requestId),
      );
      return unknownResponse(requestId, uid);
    }
    if (checked.kind === "mismatch") {
      return refuseStored(session, requestId, uid, patientId, detail, stored, checked);
    }

    // 新しく入った画像の検査にだけ印を付ける（もうあった画像は、装置から届いた検査でもありうる）。印を付けられなくても、
    // 画像は入っているので成功とし、付けられなかったことを記録に残す
    const labeled = stored.status === "Success" ? await label(backend, stored.orthancStudyId) : false;
    try {
      await result("success", { status: stored.status, orthancStudyId: stored.orthancStudyId, orthancInstanceId: stored.instanceId, labeled });
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
    const uid = o.studyInstanceUid ?? "";
    if (o.phase === "requested" || o.outcome === "unknown") {
      const file = requestFile(rows);
      const backend = getBackend();
      const reconcileDetail = file ? { requestId, ...(file.batch ? { batch: file.batch } : {}), sopInstanceUid: file.sopInstanceUid } : { requestId };
      // 保存した値が違って、入れた画像を消そうとした要求：消す画像（Orthanc の答えの画像の ID）を名指しで読み、もう無いと
      // 読めたときだけ失敗を足して解く（同じ SOP Instance UID のほかの画像には左右されない）。まだあれば（消せなかった・答えが
      // 分からない）、結果不明のまま管理者の確かめに残す（消し直さない）。読めなければ投げる（結果不明のまま）
      const cleanup = cleanupTarget(rows);
      if (cleanup) {
        if (await backend.instanceExists(cleanup)) {
          return Response.json(
            { requestId, outcome: "unknown", studyInstanceUid: uid, removed: false, error: `${MISMATCH}。取り込んだ画像が残っています。管理者に連絡してください` },
            { status: 202 },
          );
        }
        await audit(session, {
          action: "import",
          outcome: "failed",
          patientId: file?.patientId ?? null,
          studyInstanceUid: uid,
          detail: { ...reconcileDetail, phase: "reconcile", reason: "stored_mismatch", cleanup: "removed", orthancInstanceId: cleanup },
        });
        return Response.json({ requestId, outcome: "failed", studyInstanceUid: uid, removed: true, reconciled: true });
      }
      const found = file ? await backend.findInstanceStudy(file.sopInstanceUid) : null;
      // 入っていると読めたときだけ、POST と同じく Orthanc が保存した値と照らす。無いだけでは失敗と確定しない
      // （Orthanc が書き終える前の照らしもありうる）。照らした値が合えば成功を足し、印を付ける
      if (found && file) {
        // 「求めた」の行の患者 ID は記録の形（recorded）なので、Orthanc の値も同じ形にして比べる
        const checked = await checkStored(
          backend,
          found,
          { studyInstanceUid: uid, sopInstanceUid: file.sopInstanceUid, patientId: file.patientId, compare: (a, b) => samePatientId(recorded(a), b) },
        );
        // 値が違うときは消さない：SOP Instance UID で見つけただけでは、この要求が入れた画像と言えない（答えが分からない間に、
        // ほかの道で同じ UID の画像が届いたのかもしれない）。結果不明のまま、管理者の確かめに残す
        if (checked.kind === "mismatch") {
          return Response.json(
            { requestId, outcome: "unknown", studyInstanceUid: uid, error: `${MISMATCH}。管理者に連絡してください`, mismatched: checked.mismatched },
            { status: 202 },
          );
        }
        if (checked.kind === "ok") {
          const labeled = await label(backend, found.orthancStudyId);
          await audit(session, {
            action: "import",
            outcome: "success",
            patientId: file.patientId,
            studyInstanceUid: uid,
            detail: { ...reconcileDetail, phase: "reconcile", orthancStudyId: found.orthancStudyId, orthancInstanceId: found.instanceId, labeled },
          });
          return Response.json({ requestId, outcome: "stored", studyInstanceUid: uid, reconciled: true, labeled });
        }
      }
    }
    return priorResponse(session, requestId, uid, rows);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Orthanc にもうある画像・検査（取り込みを断る理由）。無ければ null。
 * 同じ StudyInstanceUID の検査は、同じ利用者が同じ組で先に入れた検査（Orthanc の ID が1つで、記録の成功の行のものと同じ）に、
 * 同じ患者 ID の画像を続けて入れるときだけ通す
 */
async function existingTarget(
  backend: Backend,
  db: Db,
  session: Session,
  dicom: DicomFileHeader,
  batchId: string | undefined,
): Promise<{ reason: "instance_exists" | "study_exists"; orthancStudyId?: string } | null> {
  try {
    const instance = await backend.findInstanceStudy(dicom.sopInstanceUid);
    if (instance) return { reason: "instance_exists", orthancStudyId: instance.orthancStudyId };
  } catch (error) {
    // 同じ SOP Instance UID の画像が複数ある（409）も、もうある画像として断る
    if (error instanceof BackendError && error.status === 409) return { reason: "instance_exists" };
    throw error;
  }
  const ids = await backend.lookupStudyIds(dicom.studyInstanceUid);
  if (ids.length === 0) return null;
  if (batchId && ids.length === 1) {
    const ours = await batchStudies(db, session, batchId, dicom.studyInstanceUid);
    const info = ours.has(ids[0]!) ? await backend.studyInfo(ids[0]!) : null;
    if (info && info.studyInstanceUid === dicom.studyInstanceUid && samePatientId(info.patientId, dicom.patientId)) return null;
  }
  return { reason: "study_exists", ...(ids.length === 1 ? { orthancStudyId: ids[0]! } : {}) };
}

/**
 * Orthanc を引き当てた後（記録の番号 since より後）に始まった、ほかの要求の ID の取り込み（断った行は除く）。同じ画像なら
 * instance_exists、同じ検査なら study_exists（同じ利用者の同じ組の別の画像だけは除く）。無ければ null。
 * 引き当てと「求めた」の記録の間に、並んで届いた取り込みが入ると、どちらも引き当てを通るため（記録の並びの中で確かめる）
 */
async function startedSince(
  tx: Tx,
  session: Session,
  since: number,
  requestId: string,
  dicom: DicomFileHeader,
  batchId: string | undefined,
): Promise<"instance_exists" | "study_exists" | null> {
  // 同じ画像は、検査をまたいで探す（同じ SOP Instance UID で StudyInstanceUID の違うファイルが並んで届いたときも見つける）。
  // 引き当ての後に始まったものに加えて、引き当ての前に始まってまだ結果の分からないもの（Orthanc に入る前かもしれない）も断る
  const sameSop = await tx.auditLog.findMany({
    where: { action: "import", outcome: { not: "denied" }, detail: { contains: `"sopInstanceUid":"${dicom.sopInstanceUid}"` } },
    select: { seq: true, actorId: true, outcome: true, studyInstanceUid: true, detail: true },
    orderBy: { seq: "asc" },
  });
  // SOP Instance UID を持つ行は、要求の ID と検査を集めるためだけに使い、解けたかは要求の行の全部で決める
  // （照らし合わせの行など、SOP Instance UID を持たない行もあるため）
  const candidates = new Map<string, string>();
  for (const row of sameSop) {
    const d = parse(row.detail);
    if (d.sopInstanceUid !== dicom.sopInstanceUid || !isRequestId(d.requestId) || d.requestId === requestId) continue;
    if (row.seq > since) return "instance_exists";
    if (!candidates.has(d.requestId)) candidates.set(d.requestId, row.studyInstanceUid ?? "");
  }
  for (const [id, study] of candidates) {
    if (isUnresolved(requestOutcome(await rowsOfRequest(tx, "import", id, study)))) return "instance_exists";
  }
  const rows = await tx.auditLog.findMany({
    where: { action: "import", studyInstanceUid: dicom.studyInstanceUid, seq: { gt: since }, outcome: { not: "denied" } },
    select: { actorId: true, detail: true },
  });
  let study = false;
  for (const row of rows) {
    const d = parse(row.detail);
    if (d.requestId === requestId) continue;
    if (d.sopInstanceUid === dicom.sopInstanceUid) return "instance_exists";
    const sameBatch = batchId !== undefined && row.actorId === session.actorId && (d.batch as { id?: unknown } | undefined)?.id === batchId;
    if (!sameBatch) study = true;
  }
  return study ? "study_exists" : null;
}

/** 同じ利用者が同じ組で、この検査に入れた（成功の結果・照らし合わせの行のある）Orthanc の検査の ID */
async function batchStudies(db: Db, session: Session, batchId: string, uid: string): Promise<Set<string>> {
  const rows = await db.auditLog.findMany({
    where: { action: "import", studyInstanceUid: uid, actorId: session.actorId, outcome: "success", detail: { contains: `"batch":{"id":"${batchId}"` } },
    select: { detail: true },
  });
  const ids = new Set<string>();
  for (const row of rows) {
    const d = parse(row.detail);
    if ((d.phase === "result" || d.phase === "reconcile") && typeof d.orthancStudyId === "string") ids.add(d.orthancStudyId);
  }
  return ids;
}

/**
 * 同じ検査の、まだ結果の分からない要求の ID：取り込み・削除（「求めた」のまま・結果不明）、値の修正（属性・中身）、
 * HL7 の更新と値の修正の書き換え（結果不明・部分反映・閉じていない組。src/lib/keep-uid-write.ts の unresolved と同じ読み方）
 */
async function pendingOnStudy(tx: Tx, uid: string): Promise<string[]> {
  const ids = [
    ...(await unresolvedRequests(tx, "import", uid, () => true)),
    ...(await unresolvedRequests(tx, "delete", uid, () => true)),
    ...(await pendingContent(tx, uid)),
    ...(await pendingAttribute(tx, uid)),
  ];
  const writeActions: AuditAction[] = ["hl7", "modify"];
  const starts = await tx.auditLog.findMany({
    where: { action: { in: writeActions }, detail: { contains: uid } },
    select: { detail: true },
    orderBy: { seq: "asc" },
  });
  const writeIds = new Set<string>();
  for (const row of starts) {
    const d = parse(row.detail);
    const touches = d.StudyInstanceUID === uid || (Array.isArray(d.group) && d.group.includes(uid));
    if ((d.event === "request" || d.event === "group") && touches && typeof d.writeId === "string") writeIds.add(d.writeId);
  }
  for (const writeId of writeIds) {
    const rows = await tx.auditLog.findMany({
      where: { action: { in: writeActions }, detail: { contains: `"writeId":"${writeId}"` } },
      select: { outcome: true, detail: true },
      orderBy: { seq: "asc" },
    });
    const last = rows.filter((r) => ["result", "reconcile"].includes(String(parse(r.detail).event))).at(-1);
    const d = last ? parse(last.detail) : {};
    if (!last || (d.manual !== true && (last.outcome === "unknown" || d.partial === true))) ids.push(writeId);
  }
  return [...new Set(ids)];
}

type Checked =
  | { kind: "ok" }
  | { kind: "unreadable" }
  | { kind: "mismatch"; mismatched: string[]; stored: { studyInstanceUid: string; patientId: string; studies: number } };

/**
 * Orthanc が保存した値（画像の親の検査の StudyInstanceUID と患者 ID、同じ UID の検査の数）を、ファイルから読んだ値と照らす。
 * 読めなければ unreadable（失敗とも成功とも決めない）
 */
async function checkStored(
  backend: Backend,
  stored: { orthancStudyId: string; instanceId: string },
  expected: { studyInstanceUid: string; sopInstanceUid: string; patientId: string; compare: (orthanc: string, file: string) => boolean },
): Promise<Checked> {
  let info: Awaited<ReturnType<Backend["studyInfo"]>>;
  let ids: string[];
  // 同じ SOP Instance UID の画像が、入れた画像のほかにもある（患者違い・検査違いで同じ UID の画像ができた）
  let otherInstance: boolean;
  try {
    info = await backend.studyInfo(stored.orthancStudyId);
    ids = await backend.lookupStudyIds(expected.studyInstanceUid);
  } catch {
    return { kind: "unreadable" };
  }
  try {
    otherInstance = (await backend.findInstanceStudy(expected.sopInstanceUid))?.instanceId !== stored.instanceId;
  } catch (error) {
    // 2 つ以上あると 409（findInstanceStudy はどれかを選ばない）
    if (!(error instanceof BackendError && error.status === 409)) return { kind: "unreadable" };
    otherInstance = true;
  }
  if (!info) return { kind: "unreadable" };
  const mismatched = [
    ...(info.studyInstanceUid !== expected.studyInstanceUid ? ["studyInstanceUid"] : []),
    ...(!expected.compare(info.patientId, expected.patientId) ? ["patientId"] : []),
    // 同じ UID の検査が、入れた画像の検査のほかにもある（患者 ID の違う同じ UID の検査ができた）
    ...(ids.length !== 1 || ids[0] !== stored.orthancStudyId ? ["studyCount"] : []),
    ...(otherInstance ? ["instanceCount"] : []),
  ];
  if (mismatched.length === 0) return { kind: "ok" };
  return {
    kind: "mismatch",
    mismatched,
    stored: { studyInstanceUid: recorded(info.studyInstanceUid), patientId: recorded(info.patientId), studies: ids.length },
  };
}

const MISMATCH = "画像サーバーが保存した患者IDまたはStudy Instance UIDが、ファイルの値と違います";

/**
 * POST の取り込みの直後に、Orthanc が保存した値がファイルから読んだ値と違った。
 * - もうあった画像（AlreadyStored）は、このインポートで入れたものではないので消さず、失敗として記録する。
 * - 新しく入れた画像（Success。Orthanc の答えの画像の ID で、この要求が入れたと分かる）は、消す前に「消す」の行
 *   （cleanup_request。要求は解けていないまま）を記録してから消す。記録できなければ消さない（結果不明のまま）。
 *   消えたと読めたときだけ、結果を失敗として記録する。消せなかった・答えが分からないときは、結果を結果不明として記録し、
 *   要求は解けていないまま残す（同じ検査の取り込みを止め、状態の確認で、画像がまだあるかを照らす）
 */
async function refuseStored(
  session: Session,
  requestId: string,
  uid: string,
  patientId: string,
  detail: Record<string, unknown>,
  stored: { status: "Success" | "AlreadyStored"; instanceId: string; orthancStudyId: string },
  checked: Extract<Checked, { kind: "mismatch" }>,
): Promise<Response> {
  const common = { action: "import" as const, patientId, studyInstanceUid: uid };
  const facts = {
    reason: "stored_mismatch",
    mismatched: checked.mismatched,
    stored: checked.stored,
    status: stored.status,
    orthancStudyId: stored.orthancStudyId,
    orthancInstanceId: stored.instanceId,
  };
  if (stored.status === "AlreadyStored") {
    await audit(session, { ...common, outcome: "failed", detail: { ...detail, phase: "result", ...facts, cleanup: "not_ours" } });
    return Response.json({ requestId, outcome: "failed", studyInstanceUid: uid, error: MISMATCH, mismatched: checked.mismatched }, { status: 409 });
  }
  try {
    await audit(session, { ...common, outcome: "unknown", detail: { ...detail, phase: "cleanup_request", ...facts } });
  } catch {
    logRecordFailure(requestId);
    return unknownResponse(requestId, uid);
  }

  let cleanup: "removed" | "failed" | "unknown";
  let note: Record<string, unknown> = {};
  try {
    await getBackend().deleteImportedInstance(stored.instanceId);
    cleanup = "removed";
  } catch (error) {
    if (error instanceof BackendUnknownError) cleanup = "unknown";
    else if (error instanceof BackendError && error.status === 404) {
      cleanup = "removed";
      note = { absent: true };
    } else {
      cleanup = "failed";
      note = { deleteStatus: error instanceof BackendError ? error.status : 502 };
    }
  }
  const removed = cleanup === "removed";
  try {
    await audit(session, {
      ...common,
      outcome: removed ? "failed" : "unknown",
      detail: { ...detail, phase: "result", ...facts, cleanup, ...note },
    });
  } catch {
    logRecordFailure(requestId);
    return unknownResponse(requestId, uid);
  }
  if (removed) {
    return Response.json(
      { requestId, outcome: "failed", studyInstanceUid: uid, removed: true, error: `${MISMATCH}。取り込んだ画像を消しました`, mismatched: checked.mismatched },
      { status: 409 },
    );
  }
  return Response.json(
    {
      requestId,
      outcome: "unknown",
      studyInstanceUid: uid,
      removed: false,
      error: `${MISMATCH}。取り込んだ画像を消せませんでした。管理者に連絡してください`,
      mismatched: checked.mismatched,
    },
    { status: 502 },
  );
}

/** 「消す」の行（cleanup_request）に残した、このインポートで入れた画像の Orthanc の ID。無ければ null */
function cleanupTarget(rows: readonly RequestRow[]): string | null {
  for (const row of rows) {
    const d = parse(row.detail);
    if (d.phase === "cleanup_request" && typeof d.orthancInstanceId === "string") return d.orthancInstanceId;
  }
  return null;
}

/** インポートの印を付ける。付けられなくても画像は入っているので、付けたかだけを返す */
async function label(backend: Backend, orthancStudyId: string): Promise<boolean> {
  try {
    await backend.labelImported(orthancStudyId);
    return true;
  } catch {
    return false;
  }
}

function parse(detail: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(detail ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 「求めた」の行に残したファイル（SOP Instance UID・SHA-256・患者 ID・組）。無ければ null */
function requestFile(
  rows: readonly (RequestRow & { patientId?: string | null })[],
): { sopInstanceUid: string; sha256: string; patientId: string; batch?: unknown } | null {
  for (const row of rows) {
    const d = parse(row.detail);
    if (d.phase === "request" && typeof d.sopInstanceUid === "string" && typeof d.sha256 === "string") {
      return { sopInstanceUid: d.sopInstanceUid, sha256: d.sha256, patientId: row.patientId ?? "", ...(d.batch ? { batch: d.batch } : {}) };
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
