import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getBackend } from "@/lib/backend";
import { BackendError, BackendUnknownError, type Backend, type PatientInstance } from "@/lib/backend/types";
import {
  checkCharset,
  checkStudyInstances,
  history,
  reconcile,
  writeAndVerify,
  writeAudit,
  type AuditRow,
  type AuditWriter,
  type HistoryRow,
  type ProcessOptions,
} from "@/lib/keep-uid-write";
import { visible } from "../../../hl7-receiver/visible";
import { parseMessage } from "./message";
import { extractUpdate, type Command } from "./update";
import { buildAck } from "./ack";

// HL7 による患者情報の更新（design.md）。UID を保つ書き換え・確かめ・照らし合わせの部品は src/lib/keep-uid-write.ts にあり、
// 画面の属性の訂正と共有する。ここには、メッセージの受理・重複の確かめ・HL7 の命令から書き換えの段取りを作る部分を置く。
export {
  enqueue,
  history,
  HistoryTampered,
  QueueFull,
  reconcile,
  unresolved,
  verify,
  writeAndVerify,
  writeAudit,
  type AuditRow,
  type AuditWriter,
  type HistoryRow,
  type ProcessOptions,
  type WriteDetail,
} from "@/lib/keep-uid-write";

export type ReceiverEvent = "refused" | "oversize" | "timeout" | "framing" | "busy" | "dropped";

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
  /** 画面の患者 ID の付け替えの覚え（監査の記録の modify の結果の行に入れる。付け替えた検査だけを統合する） */
  origin?: "screen";
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
  const p = checkStudyInstances(before);
  // 患者 ID での検索は検査の要約で引くので、画像の患者 ID もメッセージの患者 ID と同じかを確かめる（揃いは上で確かめた）
  if (command.kind !== "ORM" && p.PatientID !== (command.kind === "A40" ? command.priorPatientId : command.patientId)) {
    throw new BackendError("画像の患者 ID がメッセージの患者 ID と違う");
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
  checkCharset(replace, before);
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
    if (!await reconcile(backend, rows, audit, options)) {
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
