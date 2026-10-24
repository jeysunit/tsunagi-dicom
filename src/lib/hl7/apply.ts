/* eslint-disable no-control-regex -- ASCII と制御文字の検証。 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { appendAudit, type AuditEntryInput, type AuditOutcome } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { getBackend } from "@/lib/backend";
import { BackendError, BackendUnknownError, type Backend, type PatientInstance } from "@/lib/backend/types";
import { visible } from "../../../hl7-receiver/visible";
import { parseMessage } from "./message";
import { extractUpdate, type Command } from "./update";
import { buildAck } from "./ack";

export type ReceiverEvent = "refused" | "oversize" | "timeout" | "framing" | "busy" | "dropped";

export type AuditWriter = (input: AuditEntryInput) => Promise<unknown>;

export type HistoryRow = AuditEntryInput & {
  occurredAt?: Date;
};
const writeAudit: AuditWriter = async (input) => appendAudit(await getDb(), input);
/** 監査の一本のつなぎから、HL7 の経過を古い順に読む（design.md §13）。 */
export async function history(): Promise<HistoryRow[]> {
  const rows = await (await getDb()).auditLog.findMany({ where: { action: "hl7" }, orderBy: { seq: "asc" } });
  return rows.map(r => ({
    ...r,
    action: "hl7",
    outcome: r.outcome as AuditOutcome,
    detail: r.detail ? JSON.parse(r.detail) : {}
  }));
}
/** 本文を含めず、受け口の知らせだけを監査に残す（design.md §12・§13）。 */
export async function recordReceiverEvent(
  peer: string,
  event: ReceiverEvent,
  audit: AuditWriter = writeAudit,
  aggregate: Record<string, unknown> = {},
): Promise<void> {
  await audit({
    actorId: "hl7-receiver",
    actorRole: "system",
    authMode: "hl7",
    action: "hl7",
    sourceAddressUnverified: visible(peer),
    outcome: "denied",
    detail: { event, ...aggregate }
  });
}
const KEY = Symbol.for("tsunagi-dicom.hl7-queue");
const holder = globalThis as typeof globalThis & {
  [KEY]?: {
    tail: Promise<unknown>;
    size: number;
  };
};

export class QueueFull extends Error {
}
/** 処理を直列にし、待ちを16通までに絞る（design.md §3）。 */
export function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const queue = holder[KEY] ??= { tail: Promise.resolve(), size: 0 };
  if (queue.size >= 17) {
    return Promise.reject(new QueueFull());
  }
  queue.size++;
  const next = queue.tail.then(work, work).finally(() => {
    queue.size--;
  });
  queue.tail = next.catch(() => undefined);
  return next;
}
const values = [
  "PatientID",
  "PatientName",
  "PatientBirthDate",
  "PatientSex",
  "AccessionNumber"
] as const;
const triple = (r: PatientInstance) => [r.StudyInstanceUID, r.SeriesInstanceUID, r.SOPInstanceUID].join("|");

export interface WriteDetail {
  writeId: string;
  messageId: string;
  oldOrthancId: string;
  StudyInstanceUID: string;
  before: PatientInstance[];
  after: PatientInstance[];
}
/** 人が解くまで、期限を設けず結果不明と部分反映を拾う（design.md §10）。 */
export function unresolved(rows: HistoryRow[]): WriteDetail[] {
  return rows.filter(r => r.detail?.event === "request").map(r => r.detail as unknown as WriteDetail).filter(d => {
    const last = rows.filter(r => r.detail?.writeId === d.writeId && ["result", "reconcile"].includes(String(r.detail?.event))).at(-1);
    return !last || (last.detail?.manual !== true && (last.outcome === "unknown" || last.detail?.partial === true));
  });
}
/** 全画像の UID の組と属性を前後の値に照らす（design.md §4）。 */
export async function verify(backend: Backend, d: WriteDetail) {
  const ids = await backend.lookupStudyIds(d.StudyInstanceUID);
  const actual = ids.length === 1 ? await backend.studyInstanceTags(ids[0]!) : [];
  const matches = (expected: PatientInstance[]) => {
    if (!actual.length || actual.length !== expected.length) {
      return false;
    }
    if (new Set(expected.map(triple)).size !== expected.length) {
      return false;
    }
    if (new Set(actual.map(triple)).size !== actual.length) {
      return false;
    }
    return expected.every(e => actual.some(a => triple(a) === triple(e) && values.every(k => a[k] === e[k])));
  };
  return {
    matchesAfter: matches(d.after),
    matchesBefore: matches(d.before),
    newOrthancId: ids.length === 1 ? ids[0] : null
  };
}
/** 終わった仕事だけを照らし、部分反映と仕事の ID 不明は残す（design.md §10）。 */
export async function reconcile(backend: Backend, rows: HistoryRow[], audit: AuditWriter): Promise<boolean> {
  for (const d of unresolved(rows)) {
    const last = rows.filter(r => r.detail?.writeId === d.writeId).at(-1);
    if (last?.detail?.partial === true) {
      continue;
    }
    const dispatch = rows.find(r => r.detail?.event === "dispatch" && r.detail?.writeId === d.writeId);
    if (!dispatch) {
      continue;
    }
    try {
      const job = await backend.jobStatus(String(dispatch.detail?.jobId));
      if (!job || !["Success", "Failure"].includes(job.state)) {
        continue;
      }
      const checked = await verify(backend, d);
      const success = job.state === "Success" && checked.matchesAfter;
      // Success の不一致は、前の値と同じでも自動で解かない（design.md §4）。
      const partial = !success && (job.state === "Success" || !checked.matchesBefore);
      const row: HistoryRow = {
        actorId: "hl7-receiver",
        actorRole: "system",
        authMode: "hl7",
        action: "hl7",
        outcome: success ? "success" : "failed",
        detail: { ...d, event: "reconcile", partial, ...checked }
      };
      await audit(row);
      rows.push(row);
    } catch { /* 読めない仕事は解かない。 */
    }
  }
  return unresolved(rows).length === 0;
}

export interface ProcessOptions {
  readHistory?: () => Promise<HistoryRow[]>;
  issuer?: string;
  allowWrite?: boolean;
  pollMs?: number;
  jobTimeoutMs?: number;
}
// 空欄を埋める基準を先に一つに決め、検査ごとの取り違えを防ぐ（design.md §9）。
async function mergeAttributes(backend: Backend, command: Command, sources: PatientInstance[][]) {
  let attributes = command.attributes;
  if (command.kind !== "A40" || !sources.length) {
    return attributes;
  }
  const targets = await backend.findStudiesByPatientId(command.patientId);
  const basis = targets.length ? (await Promise.all(targets.map(id => backend.studyInstanceTags(id)))).flat() : sources.flat();
  if (!basis.length || ["PatientName", "PatientBirthDate", "PatientSex"].some(
    k => basis.some(p => p[k as keyof PatientInstance] !== basis[0]![k as keyof PatientInstance])
  )) {
    throw new BackendError("患者の検査どうしで属性が揃っていない");
  }
  if (targets.length && Object.entries(attributes).some(([k, v]) => basis[0]![k as keyof PatientInstance] !== v)) {
    throw new BackendError("替え先の患者の属性が違う。先に A08 で揃える");
  }
  attributes = {
    PatientName: basis[0]!.PatientName,
    PatientBirthDate: basis[0]!.PatientBirthDate,
    PatientSex: basis[0]!.PatientSex,
    ...attributes
  };
  return attributes;
}

function planStudy(command: Command, attributes: Record<string, string>, id: string, before: PatientInstance[]) {
  if (!before.length) {
    throw new BackendError("検査の画像が見つからない");
  }
  const p = before[0]!;
  const invalidUid = before.some(instance =>
    !instance.StudyInstanceUID || !instance.SeriesInstanceUID || !instance.SOPInstanceUID
    || instance.StudyInstanceUID !== p.StudyInstanceUID);
  if (new Set(before.map(triple)).size !== before.length || invalidUid) {
    throw new BackendError("画像の UID の組が正しくない");
  }
  if (before.some(x => values.some(k => x[k] !== p[k]))) {
    throw new BackendError("画像どうしで属性が揃っていない");
  }
  const replace: Record<string, string> = {
    PatientID: p.PatientID,
    PatientName: p.PatientName,
    PatientBirthDate: p.PatientBirthDate,
    PatientSex: p.PatientSex
  };
  if (command.kind === "ORM") {
    if (p.PatientID !== command.patientId) {
      throw new BackendError("患者 ID が一致しない。先に A40 を送る");
    }
    if (p.AccessionNumber && p.AccessionNumber !== command.accession) {
      throw new BackendError("別の受付番号が入っている");
    }
    replace.AccessionNumber = command.accession!;
  } else {
    Object.assign(replace, attributes);
    if (command.kind === "A40") {
      replace.PatientID = command.patientId;
    }
  }
  if (Object.values(replace).some(v => /[^\x00-\x7f]/u.test(v)) && before.some(p => p.SpecificCharacterSet !== "ISO_IR 192")) {
    throw new BackendError("日本語は ISO_IR 192 の検査だけに書き込める");
  }
  return {
    id,
    before,
    replace,
    after: before.map(p => ({ ...p, ...replace }))
  };
}
// 古い A08 の再送で後の更新を巻き戻さない（design.md §10）。

function findPreviousMessage(rows: HistoryRow[], common: {
  sendingApplication: string;
  sendingFacility: string;
  controlId: string;
}) {
  return rows.findLast(
    r => r.detail?.event === "received"
      && r.detail?.sendingApplication === common.sendingApplication
      && r.detail?.sendingFacility === common.sendingFacility
      && r.detail?.controlId === common.controlId
      && (!r.occurredAt || Date.now() - r.occurredAt.getTime() <= 7 * 86400000)
  );
}
type AuditRow = (
  event: string,
  outcome: AuditOutcome,
  detail?: Record<string, unknown>,
  patientId?: string,
  studyInstanceUid?: string,
) => Promise<unknown>;
// request を残した後だけ書き、仕事の終わりと全画像を確かめる（design.md §4・§10）。
async function writeAndVerify(
  backend: Backend,
  plan: ReturnType<typeof planStudy>,
  messageId: string,
  row: AuditRow,
  options: ProcessOptions,
): Promise<boolean> {
  const { id, before, after, replace } = plan;
  if (before.every((p, i) => values.every(k => p[k] === after[i]![k]))) {
    return false;
  }
  const d: WriteDetail = {
    writeId: randomUUID(),
    messageId,
    oldOrthancId: id,
    StudyInstanceUID: before[0]!.StudyInstanceUID,
    before,
    after
  };
  await row("request", "success", { ...d }, after[0]!.PatientID, d.StudyInstanceUID);
  let state: string | undefined;
  let refusal: string | undefined;
  let jobCreated = false;
  try {
    // 元を消すのは患者 ID が変わる書き換え（A40）だけ（design.md §4）
    const removeSource = after[0]!.PatientID !== before[0]!.PatientID;
    const { jobId } = await backend.modifyStudyKeepingUids(id, replace, { removeSource });
    jobCreated = true;
    await row("dispatch", "success", { writeId: d.writeId, jobId });
    const deadline = Date.now() + (options.jobTimeoutMs ?? 120000);
    for (;;) {
      state = (await backend.jobStatus(jobId))?.state;
      if (state === "Success" || state === "Failure") {
        break;
      }
      if (Date.now() >= deadline) {
        throw new BackendUnknownError("仕事の完了を待つ時間を超えた");
      }
      await new Promise(r => setTimeout(r, options.pollMs ?? 250));
    }
  } catch (e) {
    if (jobCreated || !(e instanceof BackendError)) {
      await row("result", "unknown", {
        ...d,
        reason: visible(e instanceof Error ? e.message : "応答不明")
      });
      throw e;
    }
    state = "Failure";
    refusal = e.message;
  }
  let checked;
  try {
    checked = await verify(backend, d);
  } catch (e) {
    await row("result", "unknown", { ...d, reason: "画像ごとの確かめに失敗した" });
    throw e;
  }
  const success = state === "Success" && checked.matchesAfter;
  // 成功した仕事の不一致は部分反映として止め、人の確認を待つ（design.md §4）。
  const partial = !success && (state === "Success" || !checked.matchesBefore);
  await row("result", success ? "success" : "failed", {
    ...d,
    ...checked,
    partial,
    state,
    reason: refusal ? visible(refusal) : undefined
  }, after[0]!.PatientID, d.StudyInstanceUID);
  if (!success) {
    throw new BackendError(partial ? "画像の一部だけが書き換わった" : refusal ?? "書き換わらなかった");
  }
  return true;
}
/** 受信を記録し、重複と未解決の書き換えを確かめてから反映する（design.md §9・§10）。 */
export async function processMessage(
  buffer: Buffer,
  peer: string,
  backend: Backend = getBackend(),
  audit: AuditWriter = writeAudit,
  options: ProcessOptions = {},
): Promise<string> {
  const parsed = parseMessage(buffer);
  const header = parsed.ok ? parsed.msg.header : parsed.header;
  const messageId = randomUUID();
  const common = {
    messageId,
    controlId: visible(header?.controlId ?? ""),
    sendingApplication: visible(header?.sendingApplication ?? ""),
    sendingFacility: visible(header?.sendingFacility ?? ""),
    type: visible(header?.trigger ?? "")
  };
  const row: AuditRow = (event, outcome, detail = {}, patientId, studyInstanceUid) => audit({
    actorId: "hl7-receiver",
    actorRole: "system",
    authMode: "hl7",
    action: "hl7",
    sourceAddressUnverified: visible(peer),
    outcome,
    patientId,
    studyInstanceUid,
    detail: { ...common, event, ...detail }
  });
  const extracted = parsed.ok ? extractUpdate(parsed.msg, options.issuer ?? getConfig().hl7PatientIdIssuer) : {
    ok: false as const,
    code: "AR" as const,
    reason: parsed.reason
  };
  let code: "AA" | "AE" | "AR" = "AA";
  let reason = "受理した";
  let count = 0;
  try {
    if (!extracted.ok) {
      if (extracted.code === "AR") {
        await row("rejected", "denied", { reason: visible(extracted.reason) });
        return buildAck("AR", extracted.reason, header);
      }
    }
    const rows = [...await (options.readHistory ?? history)()];
    const bodyHash = createHash("sha256").update(buffer).digest("hex");
    const previous = findPreviousMessage(rows, common);
    if (previous && previous.detail?.bodyHash !== bodyHash) {
      await row("rejected", "denied", { reason: "同じ MSH-10 の別の中身" });
      return buildAck("AR", "同じ MSH-10 の別の中身", header);
    }
    const previousAck = previous && rows.findLast(r => r.detail?.event === "ack" && r.detail?.messageId === previous.detail?.messageId);
    if (previousAck) {
      return buildAck(previousAck.detail?.code as "AA" | "AE" | "AR", String(previousAck.detail?.reason ?? "受理済み"), header);
    }
    if (!previous) {
      await row("received", "success", { bodyHash });
    }
    if (!extracted.ok) {
      throw new BackendError(extracted.reason);
    }
    if (!await reconcile(backend, rows, audit)) {
      throw new BackendUnknownError("結果の分からない書き換えがある");
    }
    for (const received of rows.filter(
      r => r.detail?.event === "received" && !rows.some(a => a.detail?.event === "ack" && a.detail?.messageId === r.detail?.messageId)
    )) {
      await row("ack", "failed", {
        messageId: received.detail?.messageId,
        code: "AE",
        count: 0,
        interrupted: true,
        reason: "途中で止まったメッセージ"
      });
    }
    if (previous) {
      return buildAck("AE", "途中で止まったメッセージ", header);
    }
    if (!(options.allowWrite ?? (getConfig().auth.mode !== "dev" || getConfig().auth.devAllowWrite))) {
      throw new BackendError("検証モードの書き込みが許可されていない");
    }
    const command = extracted.command;
    const ids = command.kind === "ORM"
      ? await backend.lookupStudyIds(command.uid!)
      : await backend.findStudiesByPatientId(command.priorPatientId ?? command.patientId);
    if (command.kind === "ORM" && ids.length > 1) {
      throw new BackendError("同じ StudyInstanceUID の検査が複数ある");
    }
    if (!ids.length) {
      reason = command.kind === "A40" ? "旧い患者の検査が無い" : "検査が無い";
    }
    const sources = await Promise.all(ids.map(id => backend.studyInstanceTags(id)));
    const attributes = await mergeAttributes(backend, command, sources);
    // 全検査の入力を確かめてから、最初の書き換えを呼ぶ。
    const plans = ids.map((id, i) => planStudy(command, attributes, id, sources[i]!));
    for (const plan of plans) {
      if (await writeAndVerify(backend, plan, messageId, row, options)) {
        count++;
      }
    }
  } catch (e) {
    code = "AE";
    reason = e instanceof BackendError || e instanceof BackendUnknownError ? e.message : "反映または監査の記録に失敗した";
  }
  try {
    await row("ack", code === "AA" ? "success" : "failed", { code, count, reason: visible(reason) });
  } catch {
    code = "AE";
    reason = "監査の記録に失敗した";
  }
  return buildAck(code, reason, header);
}
