/* eslint-disable no-control-regex -- ASCII と制御文字の検証。 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { appendAudit, checkAuditRow, type AuditEntryInput, type AuditOutcome } from "@/lib/audit";
import { auditKeyring } from "@/lib/audit-key";
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
export const writeAudit: AuditWriter = async (input) => appendAudit(await getDb(), input);
/** 監査の記録の HL7 の行が、鍵つきの値とつなぎに合わない（書き換えられた・差し込まれた）。人が確かめるまで処理しない */
export class HistoryTampered extends BackendUnknownError {
  constructor(seq: number, reason: string) {
    super(`監査の記録の HL7 の行が鍵つきの値・つなぎと合わない（seq ${seq}：${reason}）`);
  }
}
/**
 * 監査の一本のつなぎから、HL7 の経過を古い順に読む（design.md §13）。使う前に、行ごとに鍵つきの値と前の行との
 * つなぎを確かめる（design.md §15.3）。覚え（remember）を持つ行は鍵つきだけを受ける。合わない行があれば投げる。
 */
export async function history(): Promise<HistoryRow[]> {
  const db = await getDb();
  const rows = await db.auditLog.findMany({ where: { action: "hl7" }, orderBy: { seq: "asc" } });
  const previous = new Map<number, string>();
  // SQLite の変数の数の上限を超えないように分けて読む
  for (let i = 0; i < rows.length; i += 500) {
    const seqs = rows.slice(i, i + 500).map(r => r.seq - 1);
    for (const p of await db.auditLog.findMany({ where: { seq: { in: seqs } }, select: { seq: true, hash: true } })) {
      previous.set(p.seq, p.hash);
    }
  }
  const keyring = auditKeyring();
  return rows.map(r => {
    let detail: Record<string, unknown>;
    try {
      detail = r.detail ? JSON.parse(r.detail) : {};
    } catch {
      throw new HistoryTampered(r.seq, "detail が JSON でない");
    }
    const reason = checkAuditRow(r, previous.get(r.seq - 1), keyring, detail?.remember !== undefined);
    if (reason) {
      throw new HistoryTampered(r.seq, reason);
    }
    return { ...r, action: "hl7" as const, outcome: r.outcome as AuditOutcome, detail };
  });
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
  /**
   * 同じ StudyInstanceUID で替え先の患者にすでにある画像（照合の後に届いた画像を書き換えるときだけ。design.md §15）。
   * 書き換えた画像はこの検査にまとまるので、前と後のどちらの確かめにも足す。
   */
  alongside?: PatientInstance[];
}
/** 人が解くまで、期限を設けず結果不明と部分反映を拾う（design.md §10）。 */
export function unresolved(rows: HistoryRow[]): WriteDetail[] {
  return rows.filter(r => r.detail?.event === "request").map(r => r.detail as unknown as WriteDetail).filter(d => {
    const last = rows.filter(r => r.detail?.writeId === d.writeId && ["result", "reconcile"].includes(String(r.detail?.event))).at(-1);
    return !last || (last.detail?.manual !== true && (last.outcome === "unknown" || last.detail?.partial === true));
  });
}
/** 画像の集まりが、UID の組と患者の値で過不足なく同じか。どちらかに UID の組の重なりがあれば同じとしない */
function sameInstances(actual: PatientInstance[], expected: PatientInstance[]): boolean {
  if (!actual.length || actual.length !== expected.length) {
    return false;
  }
  if (new Set(expected.map(triple)).size !== expected.length || new Set(actual.map(triple)).size !== actual.length) {
    return false;
  }
  return expected.every(e => actual.some(a => triple(a) === triple(e) && values.every(k => a[k] === e[k])));
}
/**
 * 患者 ID の変わる書き換えの後に、元の検査から書き換えた画像だけを名指しで消す（design.md §15）。書き換えは元を残すので、
 * 替え先の検査（元の検査の外の、同じ StudyInstanceUID の検査）が書き換えた後の画像と過不足なく合うときだけ消す。
 * 合わなければ消さずに戻り、後の確かめが部分反映として止める。消す前に元の検査にあった、書き換えていない画像
 * （最中に届いた画像）が、消した後に 1 枚でも無ければ false（名指ししていない画像まで消えた）
 */
async function removeSource(backend: Backend, d: WriteDetail): Promise<boolean> {
  const ids = (await backend.lookupStudyIds(d.StudyInstanceUID)).filter(id => id !== d.oldOrthancId);
  const copied = (await Promise.all(ids.map(id => backend.studyInstanceTags(id)))).flat();
  if (!sameInstances(copied, [...d.alongside ?? [], ...d.after])) {
    return true;
  }
  const written = new Set(d.before.map(triple));
  const source = await backend.studyInstanceTags(d.oldOrthancId);
  const named = source.filter(i => written.has(triple(i)));
  if (!named.length) {
    return true;
  }
  await backend.deleteStudyInstances(d.oldOrthancId, named);
  const left = new Set((await backend.studyInstanceTags(d.oldOrthancId)).map(triple));
  return source.every(i => written.has(triple(i)) || left.has(triple(i)));
}
/**
 * 全画像の UID の組と属性を前後の値に照らす（design.md §4）。同じ StudyInstanceUID の検査が Orthanc に
 * 2 件以上あれば、全部の画像を合わせて比べる（照合の後に届いた画像の書き換えの前は、替え先の検査と 2 件並ぶ。§15）。
 * UID の組が重なれば一致としない。
 */
export async function verify(backend: Backend, d: WriteDetail) {
  const ids = await backend.lookupStudyIds(d.StudyInstanceUID);
  const actual = (await Promise.all(ids.map(id => backend.studyInstanceTags(id)))).flat();
  const alongside = d.alongside ?? [];
  const matches = (written: PatientInstance[]) => sameInstances(actual, [...alongside, ...written]);
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
      // 患者 ID の変わる書き換えは元の検査が残るので、仕事の終わりを読めずに止まった後も、確かめてから元の画像を
      // 名指しで消す（書き換えたときと同じ。消し終えていれば何もしない。design.md §15.4）
      const arrivalsKept = job.state === "Success" && d.after[0]!.PatientID !== d.before[0]!.PatientID
        ? await removeSource(backend, d) : true;
      const checked = await verify(backend, d);
      const success = job.state === "Success" && checked.matchesAfter && arrivalsKept;
      // Success の不一致は、前の値と同じでも自動で解かない（design.md §4）。
      const partial = !success && (job.state === "Success" || !checked.matchesBefore);
      const row: HistoryRow = {
        actorId: "hl7-receiver",
        actorRole: "system",
        authMode: "hl7",
        action: "hl7",
        outcome: success ? "success" : "failed",
        detail: { ...d, event: "reconcile", partial, ...checked, ...(arrivalsKept ? {} : { arrivalsLost: true }) }
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

/**
 * 受理した A40 と ORM の覚え（design.md §15）。ack の行の `remember` に入れ、照合の後に仮の患者 ID で届いた画像を
 * 書き換えるときに使う。`at` は BFF の時計の受理の時刻で、期限はここから数える。
 */
export type Remembered = {
  kind: "alias";
  /** 旧い（仮の）患者 ID と、統合した先の患者 ID */
  from: string;
  to: string;
  /** この A40 で書き換えた検査の StudyInstanceUID */
  studies: string[];
  /** 書き換える前の旧い患者の氏名・生年月日・性別（検査があったときだけ）。後で届いた画像の値と比べる */
  fromNames: string[];
  fromBirthDates?: string[];
  fromSexes?: string[];
  /** 統合した先の患者の値（Orthanc に統合した先の検査が無いときに使う） */
  attributes: Record<string, string>;
  at: string;
} | {
  kind: "order";
  patientId: string;
  uid: string;
  accession: string;
  control: NonNullable<Command["control"]>;
  at: string;
};

function rememberEntry(
  command: Command,
  attributes: Record<string, string>,
  plans: { before: PatientInstance[] }[],
  at: string,
): Remembered | undefined {
  if (command.kind === "A40") {
    return {
      kind: "alias",
      from: command.priorPatientId!,
      to: command.patientId,
      studies: plans.map(p => p.before[0]!.StudyInstanceUID),
      fromNames: [...new Set(plans.flatMap(p => p.before.map(i => i.PatientName)))],
      fromBirthDates: [...new Set(plans.flatMap(p => p.before.map(i => i.PatientBirthDate)))],
      fromSexes: [...new Set(plans.flatMap(p => p.before.map(i => i.PatientSex)))],
      attributes,
      at
    };
  }
  if (command.kind === "ORM") {
    return {
      kind: "order",
      patientId: command.patientId,
      uid: command.uid!,
      accession: command.accession!,
      control: command.control ?? "NW",
      at
    };
  }
  return undefined;
}

export function planStudy(command: Command, attributes: Record<string, string>, id: string, before: PatientInstance[]) {
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
    // CA・DC は検査と画像を消さず、受付番号を外す（tsunagi は検査の状態の印を持たない。design.md §16）。
    // すでに空なら書き換えない
    replace.AccessionNumber = command.control === "CA" || command.control === "DC" ? "" : command.accession!;
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
export type AuditRow = (
  event: string,
  outcome: AuditOutcome,
  detail?: Record<string, unknown>,
  patientId?: string,
  studyInstanceUid?: string,
) => Promise<unknown>;
// request を残した後だけ書き、仕事の終わりと全画像を確かめる（design.md §4・§10）。
export async function writeAndVerify(
  backend: Backend,
  plan: ReturnType<typeof planStudy> & { alongside?: PatientInstance[] },
  messageId: string,
  row: AuditRow,
  options: ProcessOptions,
): Promise<boolean> {
  const { id, before, after, replace, alongside } = plan;
  if (before.every((p, i) => values.every(k => p[k] === after[i]![k]))) {
    return false;
  }
  const d: WriteDetail = {
    writeId: randomUUID(),
    messageId,
    oldOrthancId: id,
    StudyInstanceUID: before[0]!.StudyInstanceUID,
    before,
    after,
    ...(alongside?.length ? { alongside } : {})
  };
  await row("request", "success", { ...d }, after[0]!.PatientID, d.StudyInstanceUID);
  let state: string | undefined;
  let refusal: string | undefined;
  let jobCreated = false;
  try {
    const { jobId } = await backend.modifyStudyKeepingUids(id, replace);
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
  // 患者 ID の変わる書き換え（A40）だけ、元の検査が残る。書き換えた画像を確かめてから元の画像を名指しで消す（design.md §15）
  let arrivalsKept = true;
  try {
    if (state === "Success" && after[0]!.PatientID !== before[0]!.PatientID) {
      arrivalsKept = await removeSource(backend, d);
    }
  } catch (e) {
    await row("result", "unknown", { ...d, reason: visible(e instanceof Error ? e.message : "元の画像を消せなかった") });
    throw e;
  }
  try {
    checked = await verify(backend, d);
  } catch (e) {
    await row("result", "unknown", { ...d, reason: "画像ごとの確かめに失敗した" });
    throw e;
  }
  const success = state === "Success" && checked.matchesAfter && arrivalsKept;
  // 成功した仕事の不一致は部分反映として止め、人の確認を待つ（design.md §4）。
  const partial = !success && (state === "Success" || !checked.matchesBefore);
  await row("result", success ? "success" : "failed", {
    ...d,
    ...checked,
    ...(arrivalsKept ? {} : { arrivalsLost: true }),
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
  let remember: Remembered | undefined;
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
    remember = rememberEntry(command, attributes, plans, new Date().toISOString());
  } catch (e) {
    code = "AE";
    remember = undefined;
    reason = e instanceof BackendError || e instanceof BackendUnknownError ? e.message : "反映または監査の記録に失敗した";
  }
  try {
    // AA の ack だけに、後で届く画像の書き換えに使う覚えを付ける（design.md §15）
    await row("ack", code === "AA" ? "success" : "failed", {
      code,
      count,
      reason: visible(reason),
      ...(code === "AA" && remember ? { remember } : {})
    });
  } catch {
    code = "AE";
    reason = "監査の記録に失敗した";
  }
  return buildAck(code, reason, header);
}
