import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { BackendError, BackendUnknownError, type Backend, type OrthancStudyInfo, type PatientInstance } from "@/lib/backend/types";
import { type CorrectionKind, type CorrectionScope, type CorrectionValues, correctionScope } from "@/lib/correction-fields";
import {
  checkCharset,
  checkStudyInstances,
  KEEP_UID_VALUES,
  triple,
  writeAndVerify,
  type AuditRow,
  type KeepUidPlan,
  type ProcessOptions,
} from "@/lib/keep-uid-write";
import { visible } from "../../hl7-receiver/visible";

// 患者・検査の値の修正（docs/spec.md の 3.5。段 6。openspec/changes/add-study-value-correction/design.md）の、
// 直す検査を Orthanc から読む部分と、書き換えの段取りを作る部分。道（src/app/api/studies/[uid]/modify）が使う。
// 確かめの画面（preview）と実行の両方が同じ読み方をし、見せた状態の印（state）で、確かめの後に検査が変わっていないかを照らす。

/** 断る理由（画面に出す文言と、記録に残す短い名前） */
export class CorrectionRefused extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CorrectionRefused";
  }
}

/** 同じ StudyInstanceUID の検査が複数あるときに、画面で選ぶための要点（患者 ID・氏名・検査日・画像の数） */
export interface DuplicateCandidate {
  orthancId: string;
  patientId: string;
  patientName: string;
  studyDate: string;
  instanceCount: number;
}

/** 直す1つの検査（Orthanc の中の ID・要点・画像・同じ UID のほかの検査の画像） */
export interface CorrectionStudy {
  orthancId: string;
  info: OrthancStudyInfo;
  instances: PatientInstance[];
  alongside: PatientInstance[];
  /** 画像どうしで値の揃っていない項目（部分反映の後など） */
  mixed: string[];
}

export interface CorrectionSnapshot {
  kind: CorrectionKind;
  scope: CorrectionScope;
  /** URL の StudyInstanceUID と、選んだ検査 */
  studyInstanceUid: string;
  selected: CorrectionStudy;
  /** 書き換える検査（患者の属性の訂正は同じ患者 ID の全部。ほかは選んだ1つ） */
  studies: CorrectionStudy[];
  /** 直す値（要求に無い項目は変えない） */
  values: CorrectionValues;
  /** 選んだ検査の、直す項目の前と後の値 */
  fields: Record<string, { before: string; after: string }>;
  /** 患者 ID の付け替えの替え先の患者（Orthanc にあれば、その値にそろえる） */
  target?: { patientId: string; exists: boolean; attributes: Record<string, string> };
  /** 確かめの画面で見せた状態の印（SHA-256） */
  state: string;
}

const PATIENT_ATTRS = ["PatientName", "PatientBirthDate", "PatientSex"] as const;

/** 同じ UID の検査を引き、選んだ検査を決める。複数あって選んでいなければ、選ぶための要点を添えて断る */
async function selectStudy(backend: Backend, uid: string, orthancId: string | undefined): Promise<string> {
  const ids = await backend.lookupStudyIds(uid);
  if (ids.length === 0) throw new CorrectionRefused(404, "not_found", "検査が見つかりません");
  if (orthancId !== undefined) {
    if (!ids.includes(orthancId)) throw new CorrectionRefused(409, "changed", "確認の後に検査が更新されました。もう一度確認してください");
    return orthancId;
  }
  if (ids.length > 1) {
    const candidates: DuplicateCandidate[] = [];
    for (const id of ids) {
      const info = await backend.studyInfo(id);
      if (!info) continue;
      candidates.push({
        orthancId: id,
        patientId: info.patientId,
        patientName: info.patientName,
        studyDate: info.studyDate,
        instanceCount: (await backend.studyInstanceTags(id)).length,
      });
    }
    throw new CorrectionRefused(409, "ambiguous", "同じ StudyInstanceUID の検査が複数あります。修正する検査を選んでください", { candidates });
  }
  return ids[0]!;
}

async function readStudy(backend: Backend, uid: string, orthancId: string): Promise<CorrectionStudy> {
  const info = await backend.studyInfo(orthancId);
  if (!info || info.studyInstanceUid !== uid) throw new CorrectionRefused(409, "changed", "確認の後に検査が更新されました。もう一度確認してください");
  const instances = await backend.studyInstanceTags(orthancId);
  try {
    // 患者 ID のほかの値は、画像どうしで揃っていなくても受ける（部分反映の後に、人が確かめて揃え直すため。揃っていない項目は
    // 確かめの画面に出す）
    checkStudyInstances(instances, false);
  } catch (e) {
    throw new CorrectionRefused(409, "inconsistent", "検査の画像どうしで値が揃っていないため、修正できません", {
      detail: e instanceof Error ? e.message : "",
    });
  }
  if (instances[0]!.StudyInstanceUID !== uid) throw new CorrectionRefused(409, "changed", "確認の後に検査が更新されました。もう一度確認してください");
  const others = (await backend.lookupStudyIds(uid)).filter((id) => id !== orthancId);
  const alongside = (await Promise.all(others.map((id) => backend.studyInstanceTags(id)))).flat();
  const mixed = KEEP_UID_VALUES.filter((k) => instances.some((i) => i[k] !== instances[0]![k]));
  return { orthancId, info, instances, alongside, mixed };
}

/**
 * 値の修正の窓に最初に入れる、いまの値（選んだ検査の先頭の画像の患者の値と受付番号、検査の要約の検査日・検査名）と、
 * 画像どうしで値の揃っていない項目。同じ UID の検査が複数あって選んでいなければ、選ぶための要点を添えて断る
 */
export async function readCurrent(backend: Backend, uid: string, orthancId?: string) {
  const study = await readStudy(backend, uid, await selectStudy(backend, uid, orthancId));
  const p = study.instances[0]!;
  return {
    orthancId: study.orthancId,
    values: {
      PatientID: p.PatientID,
      PatientName: p.PatientName,
      PatientBirthDate: p.PatientBirthDate,
      PatientSex: p.PatientSex,
      AccessionNumber: p.AccessionNumber,
      StudyDate: study.info.studyDate,
      StudyDescription: study.info.studyDescription,
    },
    mixed: study.mixed,
  };
}

/** 状態の印に入れる、画像の UID の組と値（並びを決めて） */
const instanceState = (list: PatientInstance[]) =>
  list.map((i) => [triple(i), ...KEEP_UID_VALUES.map((k) => i[k]), i.SpecificCharacterSet]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

function digest(s: Omit<CorrectionSnapshot, "state">): string {
  const body = {
    kind: s.kind,
    scope: s.scope,
    uid: s.studyInstanceUid,
    selected: s.selected.orthancId,
    values: Object.fromEntries(Object.entries(s.values).sort(([a], [b]) => a.localeCompare(b))),
    studies: s.studies.map((st) => ({
      id: st.orthancId,
      uid: st.info.studyInstanceUid,
      date: st.info.studyDate,
      description: st.info.studyDescription,
      instances: instanceState(st.instances),
      alongside: instanceState(st.alongside),
    })),
    target: s.target ?? null,
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * 直す検査と前の値を Orthanc から読む（確かめの画面と、書き換える直前の両方で使う）。
 * 種類と項目が合わない・混ぜた要求は 400、検査が無ければ 404、同じ UID の検査が複数あって選んでいない・確かめの後に変わった・
 * 替え先の患者の値と違う・変わる値が無いなどは 409 で断る（CorrectionRefused）
 */
export async function readSnapshot(
  backend: Backend,
  uid: string,
  kind: CorrectionKind,
  values: CorrectionValues,
  orthancId?: string,
): Promise<CorrectionSnapshot> {
  const decided = correctionScope(kind, values);
  if ("problem" in decided) throw new CorrectionRefused(400, "invalid", decided.problem.message);
  const { scope } = decided;
  const selected = await readStudy(backend, uid, await selectStudy(backend, uid, orthancId));
  const p = selected.instances[0]!;
  let studies = [selected];
  let target: CorrectionSnapshot["target"];
  if (scope === "patient") {
    // 氏名・生年月日・性別は患者のすべての検査に共通（PS3.3 C.7.1.1）。同じ患者 ID の全部の検査に当てる
    const ids = await backend.findStudiesByPatientId(p.PatientID);
    if (!ids.includes(selected.orthancId)) throw new CorrectionRefused(409, "changed", "確認の後に検査が更新されました。もう一度確認してください");
    studies = [];
    for (const id of ids) {
      const study = id === selected.orthancId ? selected : await readStudy(backend, (await backend.studyInfo(id))?.studyInstanceUid ?? "", id);
      if (study.instances.some((i) => i.PatientID !== p.PatientID)) {
        throw new CorrectionRefused(409, "inconsistent", "同じ患者IDの検査の画像に、別の患者IDが入っているため、修正できません");
      }
      studies.push(study);
    }
  }
  if (scope === "reassign") {
    const to = values.PatientID!;
    if (to === p.PatientID) throw new CorrectionRefused(400, "invalid", "患者IDが変わっていません");
    const basis = (await Promise.all((await backend.findStudiesByPatientId(to)).map((id) => backend.studyInstanceTags(id)))).flat();
    if (basis.some((i) => PATIENT_ATTRS.some((k) => i[k] !== basis[0]![k]))) {
      throw new CorrectionRefused(409, "target_inconsistent", "付け替え先の患者の検査どうしで、氏名・生年月日・性別が揃っていないため、付け替えできません");
    }
    // 替え先の患者がいれば、その氏名・生年月日・性別にそろえる。いなければ、入力した項目だけを書き換える（入力の無い項目は
    // 画像の値のまま。画像どうしで揃っていない値を、先頭の画像の値にそろえない）
    const attributes: Record<string, string> = basis.length
      ? Object.fromEntries(PATIENT_ATTRS.map((k) => [k, basis[0]![k]]))
      : Object.fromEntries(PATIENT_ATTRS.filter((k) => values[k] !== undefined).map((k) => [k, values[k]!]));
    if (basis.length && PATIENT_ATTRS.some((k) => values[k] !== undefined && values[k] !== attributes[k])) {
      throw new CorrectionRefused(409, "target_mismatch", "付け替え先の患者の氏名・生年月日・性別と、入力した値が違います", { target: attributes });
    }
    // 付け替え先の患者に同じ UID の検査があり、同じ画像（UID の組）を持っていれば、書き換えた画像が上書きになるので断る
    const sent = new Set(selected.alongside.filter((i) => i.PatientID === to).map(triple));
    if (selected.instances.some((i) => sent.has(triple(i)))) {
      throw new CorrectionRefused(409, "target_duplicate", "付け替え先の患者に同じ画像があるため、付け替えできません");
    }
    target = { patientId: to, exists: basis.length > 0, attributes };
  }
  const after: Record<string, string> =
    scope === "reassign" ? { PatientID: values.PatientID!, ...target!.attributes } : Object.fromEntries(Object.entries(values) as [string, string][]);
  const current = (field: string) => {
    if (field === "StudyDate") return selected.info.studyDate;
    if (field === "StudyDescription") return selected.info.studyDescription;
    return p[field as keyof PatientInstance];
  };
  const fields = Object.fromEntries(Object.entries(after).map(([f, v]) => [f, { before: current(f), after: v }]));
  const changes = scope === "content"
    ? Object.values(fields).some((f) => f.before !== f.after)
    : studies.some((st) => st.instances.some((i) => Object.entries(after).some(([f, v]) => i[f as keyof PatientInstance] !== v)));
  if (!changes) throw new CorrectionRefused(400, "unchanged", "変更された項目がありません");
  // 日本語は ISO_IR 192 の検査だけに書き込める（HL7 の更新と同じ）
  for (const st of studies) {
    try {
      checkCharset(after, st.instances);
    } catch (e) {
      throw new CorrectionRefused(409, "charset", "この検査の文字コードでは、日本語の値を書き込めません", { detail: e instanceof Error ? e.message : "" });
    }
  }
  const snapshot = { kind, scope, studyInstanceUid: uid, selected, studies, values, fields, ...(target ? { target } : {}) };
  return { ...snapshot, state: digest(snapshot) };
}

/** 属性の訂正の、検査ごとの書き換えの段取り（UID を保つ書き換えの部品に渡す形） */
export function attributePlans(s: CorrectionSnapshot): KeepUidPlan[] {
  const after: Record<string, string> = s.scope === "reassign"
    ? { PatientID: s.target!.patientId, ...s.target!.attributes }
    : Object.fromEntries(Object.entries(s.values) as [string, string][]);
  return s.studies.map((st) => {
    // 直す項目だけを書き換える（確かめの画面で見せていない値を、先頭の画像の値などで上書きしない）
    const replace: Record<string, string> = { ...after };
    return { id: st.orthancId, before: st.instances, replace, after: st.instances.map((i) => ({ ...i, ...replace })), ...(st.alongside.length ? { alongside: st.alongside } : {}) };
  });
}

/** 属性の訂正を流した答え */
export interface AttributeOutcome {
  outcome: "success" | "failed" | "unknown";
  /** 書き換えた検査の数（値が変わらずに飛ばした検査は数えない）と、書き換える検査の数 */
  count: number;
  total: number;
  /** 書き換えの ID（監査の記録の書き換えの行。照らし合わせ・管理者が解くときに名指しする） */
  writes: string[];
  /** 画像の一部だけが書き換わった・同じ患者の検査の途中で止まった */
  partial: boolean;
  message?: string;
  /** 患者 ID の付け替えが成功したときの、HL7 の見回りの覚え（監査の記録の結果の行に入れる） */
  remember?: Record<string, unknown>;
}

/**
 * 属性の訂正を、検査ごとに UID を保つ書き換えの部品で流す（HL7 と同じ列の中で呼ぶ）。1つの検査で失敗・結果不明になれば、
 * 残りの検査は書き換えずに止める。row は書き換えの経過を監査の記録に残す（modify の行）
 */
export async function applyAttributeCorrection(
  backend: Backend,
  s: CorrectionSnapshot,
  requestId: string,
  row: AuditRow,
  options: ProcessOptions = {},
): Promise<AttributeOutcome> {
  const plans = attributePlans(s);
  const out: AttributeOutcome = { outcome: "success", count: 0, total: plans.length, writes: [], partial: false };
  // いま書き換えている検査の、書き換えの「求めた」の行と最後の結果の行（組を閉じるかを、例外の型でなく記録から決める）
  let current: { requested: boolean; result?: { outcome: string; partial: boolean } } = { requested: false };
  const recording: AuditRow = (event, outcome, detail = {}, patientId, studyInstanceUid) => {
    if (event === "request" && typeof detail.writeId === "string") {
      out.writes.push(detail.writeId);
      current.requested = true;
    }
    if (event === "result" && detail.group === undefined) current.result = { outcome, partial: detail.partial === true };
    if (event === "result" && detail.partial === true) out.partial = true;
    return row(event, outcome, detail, patientId, studyInstanceUid);
  };
  // 同じ患者の複数の検査を書き換えるときは、書き換えの前に組（group）の行を残し、全部を書き換え終えたら閉じる。途中で
  // 止まると（失敗・結果不明・BFF が止まった）、前の検査だけが直り、患者の検査どうしで値が食い違う（検査ごとには揃っている）。
  // 閉じていない組・部分反映や結果不明で閉じた組は、書き換えの部品の unresolved が拾い、管理者が /api/hl7/resolve で組の ID を
  // 名指しして解くまで、画面と HL7 の書き換えを止める（1つの検査の書き換えが後で照らし合わせで解けても、組は残る）
  const group = plans.length > 1 ? {
    writeId: randomUUID(),
    messageId: requestId,
    oldOrthancId: s.selected.orthancId,
    StudyInstanceUID: s.studyInstanceUid,
    before: [],
    after: [],
    group: s.studies.map((st) => st.info.studyInstanceUid),
  } : undefined;
  const patientId = s.selected.instances[0]!.PatientID;
  if (group) {
    // 組を残せなければ、どの検査も書き換えない（記録の失敗は呼び手へ投げる）
    await recording("group", "success", group, patientId, s.studyInstanceUid);
    out.writes.push(group.writeId);
  }
  for (const plan of plans) {
    current = { requested: false };
    try {
      if (await writeAndVerify(backend, plan, requestId, recording, options)) out.count++;
    } catch (e) {
      out.outcome = e instanceof BackendUnknownError ? "unknown" : "failed";
      out.message = e instanceof BackendError || e instanceof BackendUnknownError ? e.message : "修正または操作ログの記録に失敗しました";
      break;
    }
  }
  // 書き換えの部品が結果不明と記録した（仕事を作った後に状態を読めなかったなど）なら、投げた例外の型によらず結果不明
  if (out.outcome === "failed" && current.result?.outcome === "unknown") out.outcome = "unknown";
  if (out.outcome === "failed" && out.count > 0) out.partial = true;
  if (group) {
    // 全部を書き換え終えたときと、1件も変わっていないと記録から言えるとき（止まった検査が「求めた」の前に止まったか、
    // その検査の結果が部分反映でない失敗）だけ、部分反映でない組として閉じる。それ以外（結果不明を含む）は、管理者が解くまで残す
    const untouched = out.count === 0
      && (!current.requested || (current.result?.outcome === "failed" && !current.result.partial));
    const incomplete = out.outcome !== "success" && !untouched;
    try {
      await recording("result", out.outcome === "unknown" ? "unknown" : out.outcome === "success" ? "success" : "failed", {
        ...group,
        partial: incomplete,
        count: out.count,
        total: plans.length,
        ...(out.message ? { reason: visible(out.message) } : {}),
      }, patientId, s.studyInstanceUid);
    } catch {
      // 閉じる行を残せなくても、組は閉じていないまま残るので、書き換えは止まる
      out.outcome = out.outcome === "success" ? "unknown" : out.outcome;
    }
  }
  const draft = reassignMemory(s);
  if (out.outcome === "success" && draft) out.remember = { ...draft, at: new Date().toISOString() };
  return out;
}

/**
 * 患者 ID の付け替えの覚え（受理の時刻 at を除く）。付け替えの後に元の患者 ID・同じ UID で届いた画像を、HL7 の見回りが
 * 受理から 24 時間拾う（付け替えた検査だけ）。「求めた」の行にも残し、要求全体の結果を後から決めるときに使う
 */
export function reassignMemory(s: CorrectionSnapshot): Record<string, unknown> | undefined {
  if (s.scope !== "reassign" || !s.target) return undefined;
  const p = s.selected.instances[0]!;
  return {
    kind: "alias",
    origin: "screen",
    from: p.PatientID,
    to: s.target.patientId,
    studies: [s.studyInstanceUid],
    fromNames: [...new Set(s.selected.instances.map((i) => i.PatientName))],
    fromBirthDates: [...new Set(s.selected.instances.map((i) => i.PatientBirthDate))],
    fromSexes: [...new Set(s.selected.instances.map((i) => i.PatientSex))],
    attributes: s.target.attributes,
  };
}

/** 中身の訂正で作る検査の StudyInstanceUID（UUID から作る 2.25 の形。PS3.5 B.2） */
export function newStudyUid(): string {
  return `2.25.${BigInt(`0x${randomUUID().replace(/-/g, "")}`)}`;
}

/** 中身の訂正の結果を確かめた答え */
export interface ContentCheck {
  /** 作られた検査（無ければ null） */
  newOrthancId: string | null;
  /** 作られた検査が1つで、直した値・画像の数・新しい UID がそろっている */
  matches: boolean;
  /** 元の検査が残っている */
  sourceKept: boolean;
}

/**
 * 中身の訂正の後に、作られた検査を BFF が決めた StudyInstanceUID で探し、直した値と画像の数を確かめる（照らし合わせにも使う）。
 * Series・SOP の UID は元の画像と重ならないこと（新しい UID になったこと）も見る
 */
export async function checkContent(
  backend: Backend,
  d: { orthancId: string; StudyInstanceUID: string; newStudyInstanceUid: string; after: Record<string, string>; instanceCount: number },
): Promise<ContentCheck> {
  const ids = await backend.lookupStudyIds(d.newStudyInstanceUid);
  const sourceKept = (await backend.lookupStudyIds(d.StudyInstanceUID)).includes(d.orthancId);
  if (ids.length !== 1) return { newOrthancId: ids[0] ?? null, matches: false, sourceKept };
  const info = await backend.studyInfo(ids[0]!);
  const instances = await backend.studyInstanceTags(ids[0]!);
  const sourceInstances = sourceKept ? await backend.studyInstanceTags(d.orthancId) : [];
  const source = new Set(sourceInstances.map((i) => `${i.SeriesInstanceUID}|${i.SOPInstanceUID}`));
  const valuesMatch = info !== null
    && (d.after.StudyDate === undefined || info.studyDate === d.after.StudyDate)
    && (d.after.StudyDescription === undefined || info.studyDescription === d.after.StudyDescription);
  const fresh = instances.every((i) => i.StudyInstanceUID === d.newStudyInstanceUid && !source.has(`${i.SeriesInstanceUID}|${i.SOPInstanceUID}`));
  return { newOrthancId: ids[0]!, matches: valuesMatch && instances.length === d.instanceCount && fresh, sourceKept };
}

/** 中身の訂正の仕事の終わりを待つ（待つ時間を超えれば結果不明） */
export async function waitJob(backend: Backend, jobId: string, timeoutMs = 120_000, pollMs = 250): Promise<"Success" | "Failure"> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = (await backend.jobStatus(jobId))?.state;
    if (state === "Success" || state === "Failure") return state;
    if (Date.now() >= deadline) throw new BackendUnknownError("仕事の完了を待つ時間を超えた");
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
