/* eslint-disable no-control-regex -- ASCII と制御文字の検証。 */
import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { appendAudit, verifyAuditChain, type AuditEntryInput, type AuditOutcome, type AuditRow as StoredAuditRow } from "@/lib/audit";
import { readAuditAnchors } from "@/lib/audit-anchor";
import { getDb } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { getBackend } from "@/lib/backend";
import { BackendError, BackendUnknownError, LOCK_CLOCK_TOLERANCE_MS, type Backend, type PatientInstance, type SourceFiles } from "@/lib/backend/types";
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
    super(`監査の記録が鍵つきの値・つなぎと合わない（seq ${seq}：${reason}）`);
  }
}
/**
 * 監査の一本のつなぎから、HL7 の経過を古い順に読む（design.md §13）。つなぎの全部を確かめ（行の action を書き換えて
 * HL7 の行を隠されても見つける）、確かめた行のうち HL7 の行だけを返す（確かめた後に読み直さない。design.md §15.1）。
 * 覚え（remember）を持つ行は鍵つきだけを受ける。合わない行があれば投げる。
 */
export async function history(): Promise<HistoryRow[]> {
  const db = await getDb();
  // 先頭の控えを設定していれば、/api/audit/verify と同じく照らす（末尾を消して結果不明の書き換えや続きの A40 を
  // 隠されても見つける）。控えを読めなければ止める
  const anchorFile = getConfig().audit?.anchorFile;
  let anchors;
  try {
    anchors = anchorFile ? await readAuditAnchors(anchorFile) : undefined;
  } catch (e) {
    throw new HistoryTampered(0, e instanceof Error ? e.message : "先頭の控えを読めない");
  }
  // 鍵の無い行は、つなぎの決まりで最初の鍵つきの行より前だけに受ける（後ろに書き足された鍵の無い行は、偽の照らし
  // 合わせ（manual）でありうる）。覚えを持つ行は、その前の部分でも鍵つきだけを受ける（鍵を持たない者でも作れるため）
  const rows: StoredAuditRow[] = [];
  const chain = await verifyAuditChain(db, 1000, {
    ...(anchorFile ? { anchors, requireAnchors: true } : {}),
    onRow: row => {
      if (row.action === "hl7") rows.push(row);
    }
  });
  if (!chain.ok) {
    throw new HistoryTampered(chain.seq, chain.reason);
  }
  return rows.map(r => {
    let detail: Record<string, unknown>;
    try {
      detail = r.detail ? JSON.parse(r.detail) : {};
    } catch {
      throw new HistoryTampered(r.seq, "detail が JSON でない");
    }
    if (detail?.remember !== undefined && r.keyId === null) {
      throw new HistoryTampered(r.seq, "覚えを持つ行に鍵が無い");
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
  /**
   * 患者 ID の変わる書き換えの前に読んだ、元の検査の画像ごとのファイルの印（design.md §15.4）。元の画像は、印が
   * これと同じものだけを消す（書き換えの後に同じ UID で届き直した画像を消さない）。無ければ元を消さない
   */
  sourceFiles?: SourceFiles;
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
/** 付け替えの印の期限（design.md §15.4）。仕事を待つ間と元を消す前に、残りが半分を切っていれば付け直す */
const LOCK_TTL_MS = 120_000;
/**
 * 印を付けてから、元の検査の印と変更の記録の位置を読むまで待つ時間。印を付ける前に Orthanc の Lua を通り、まだ保存の
 * 終わっていない画像を、位置より前に入れきる（design.md §15.4）
 */
const LOCK_SETTLE_MS = 1_000;

interface SourceLock {
  renew(): Promise<void>;
  /** 印が切れずに続いていることを確かめ、要れば延ばす。切れたかもしれない・延ばせないときは投げる（元を消す直前に呼ぶ） */
  ensure(): Promise<void>;
  /** 付け直しに失敗した・期限を過ぎたことがある（その間に C-STORE が入りえた） */
  lost(): boolean;
  /** いまの期限（ミリ秒の時刻） */
  until(): number;
  /**
   * 付け直しを止め、印は外さずに期限で切れるのを待つ（仕事の終わりを読めないとき。仕事が写している間に外さない）。
   * この後の release は印を外さない
   */
  keep(): Promise<void>;
  release(): Promise<void>;
}
/**
 * 元の検査に付け替えの印を付ける（design.md §15.4）。Orthanc の Lua が、同じ StudyInstanceUID の C-STORE を印の間は断る。
 * 外せなくても投げない（期限で切れる）。付けられなければ投げる（Orthanc に印の設定が無い。書き換えない）。
 * 印も Orthanc への書き込みなので、最初に付ける前に record で「求めた」ことを監査の記録に残し、残せなければ付けない
 * （付け直しと外すことは、この 1 行に含める。docs/spec.md の 3.5）
 */
async function lockSource(backend: Backend, id: string, options: ProcessOptions, record: (ttlSeconds: number) => Promise<unknown>): Promise<SourceLock> {
  const ttl = options.lockTtlMs ?? LOCK_TTL_MS;
  await record(Math.ceil(ttl / 1000));
  let until = 0;
  // Lua は Orthanc の時計で比べる。lockStudy が時計のずれを margin の内と確かめるので、期限の margin 前から切れたとみなす
  const margin = options.lockClockToleranceMs ?? LOCK_CLOCK_TOLERANCE_MS;
  const expired = () => until > 0 && Date.now() >= until - margin;
  // 付け直しに一度でも失敗したら、それ以降の renew は投げる（呼び手は Orthanc への書き込みをやめる）
  let failure: unknown;
  // 外した後に、時計の付け直しが印を付け直さないように、外す前に止めて、途中の付け直しを待つ
  let released = false;
  // 付け直しは 1 つずつ（時計と仕事を待つ間の呼び出しが重なれば、途中のものを待つ。古い期限で上書きしない）
  let pending: Promise<void> | undefined;
  const renew = (): Promise<void> => {
    if (released) {
      return Promise.resolve();
    }
    pending ??= attempt().finally(() => {
      pending = undefined;
    });
    return pending;
  };
  const attempt = async () => {
    if (failure !== undefined) {
      throw failure;
    }
    // 期限を過ぎていれば（BFF が止まっていたなど）、その間に C-STORE が入りえた。付け直して隠さずに、失敗として残す
    if (expired()) {
      failure = new BackendUnknownError("付け替えの印の期限が切れたかもしれない");
      throw failure;
    }
    if (until - Date.now() > ttl / 2) {
      return;
    }
    const next = Date.now() + ttl;
    try {
      await backend.lockStudy(id, Math.ceil(next / 1000));
    } catch (e) {
      failure ??= e;
      throw e;
    }
    // 付け直しの答えが前の期限の後に来たら、その間は印が切れていたかもしれない
    if (expired()) {
      failure ??= new BackendUnknownError("付け替えの印の期限が切れたかもしれない");
      throw failure;
    }
    until = next;
  };
  await renew();
  // 仕事を待つ間・元の検査を読む間・写しを確かめる間も切らさないように、期限の 4 分の 1 ごとに付け直す
  const timer = setInterval(() => void renew().catch(() => undefined), Math.max(ttl / 4, 10));
  timer.unref?.();
  let kept = false;
  const stop = async () => {
    released = true;
    clearInterval(timer);
    await pending?.catch(() => undefined);
  };
  return {
    renew,
    // 期限を過ぎていれば、その間に C-STORE が入りえたので、付け直して続けずにやめる（renew が確かめる）
    ensure: renew,
    lost: () => failure !== undefined || (!released && expired()),
    until: () => until,
    keep: async () => {
      kept = true;
      await stop();
    },
    release: async () => {
      await stop();
      if (kept) {
        return;
      }
      try {
        await backend.unlockStudy(id);
      } catch {
        console.warn("HL7 の付け替えの印を外せなかった（期限で切れる）");
      }
    }
  };
}
type RemoveOutcome = {
  /** 消す前に元の検査にあった、書き換えていない画像（最中に届いた画像）が消えた */
  arrivalsLost?: true;
  /**
   * 替え先の書き換えた画像の ModifiedFrom が、元の画像の ID と合わない（写しが同じ UID の別の画像に置き換わった）。
   * 消す前に見つければ元は消さない。消した後に見つけたとき（確かめから消すまでの間に置き換わった）も、成功にしない
   */
  foreignCopies?: true;
  /** 付け替えの印が途中で切れた・付け直せなかった（その間の C-STORE を写しが黙って上書きしえた）。元は消さない */
  lockLost?: true;
};
/**
 * 患者 ID の変わる書き換えの後に、元の検査から書き換えた画像だけを名指しで消す（design.md §15）。書き換えは元を残すので、
 * 替え先の検査（元の検査の外の、同じ StudyInstanceUID の検査）が書き換えた後の画像と過不足なく合い、書き換えた画像の
 * ModifiedFrom がどれも元の画像の ID と同じときだけ消す。合わなければ消さずに戻り、後の確かめが部分反映として止める。
 * 消す前に元の検査にあった、書き換えていない画像（最中に届いた画像）が、消した後に 1 枚でも無ければ arrivalsLost
 * （名指ししていない画像まで消えた）
 */
async function removeSource(backend: Backend, d: WriteDetail, lock?: SourceLock): Promise<RemoveOutcome> {
  // 元の検査の画像。画像を全部消すと Orthanc は検査ごと無くすので、引き当てに無ければ空とする
  const sourceInstances = async () =>
    (await backend.lookupStudyIds(d.StudyInstanceUID)).includes(d.oldOrthancId) ? backend.studyInstanceTags(d.oldOrthancId) : [];
  const ids = (await backend.lookupStudyIds(d.StudyInstanceUID)).filter(id => id !== d.oldOrthancId);
  const copied = (await Promise.all(ids.map(id => backend.studyInstanceTags(id)))).flat();
  if (!sameInstances(copied, [...d.alongside ?? [], ...d.after])) {
    return {};
  }
  if (!d.sourceFiles) {
    return {};
  }
  const written = new Set(d.before.map(triple));
  // 写しの確かめ：Orthanc は書き換えの写しに元の画像の ID（ModifiedFrom）を残す。写しの後に同じ UID の画像が
  // REST・STOW-RS で届いて置き換わると、ModifiedFrom が無くなる。元の画像の ID の無い前の版の記録では消さない
  const sourceIds = d.sourceFiles.ids;
  const copiesFromSource = async () => {
    const origins = Object.assign({}, ...await Promise.all(ids.map(id => backend.studyInstanceOrigins(id)))) as Record<string, string | null>;
    return Boolean(sourceIds) && [...written].every(key => sourceIds![key] && origins[key] === sourceIds![key]);
  };
  if (!await copiesFromSource()) {
    return { foreignCopies: true };
  }
  const source = await sourceInstances();
  const named = source.filter(i => written.has(triple(i)));
  if (named.length) {
    // 印の無いまま元を消さない（照らし合わせが印を付ける前の引き当てで元を見つけられず、その後に見つけたときなど）
    if (!lock) {
      return { lockLost: true };
    }
    // 1 枚を消す直前ごとに、印が切れずに続いていることを確かめる（切れたかもしれなければ消すのをやめる）
    await backend.deleteStudyInstances(d.oldOrthancId, named, d.sourceFiles, lock.ensure);
  }
  const left = new Set((await sourceInstances()).map(triple));
  const outcome: RemoveOutcome = source.every(i => written.has(triple(i)) || left.has(triple(i))) ? {} : { arrivalsLost: true };
  // 確かめてから消すまでの間に、写しが REST・STOW-RS で置き換わった（印では止まらない）。元はもう消えたので、部分反映として
  // 人に見せる（design.md §15.4 の残る隙）
  if (named.length && !await copiesFromSource()) {
    outcome.foreignCopies = true;
  }
  return outcome;
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
export async function reconcile(backend: Backend, rows: HistoryRow[], audit: AuditWriter, options: ProcessOptions = {}): Promise<boolean> {
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
      // 名指しで消す（書き換えたときと同じ。消し終えていれば何もしない。design.md §15.4）。元の検査が残っていれば、
      // 消す間は付け替えの印を付ける
      let removed: RemoveOutcome = {};
      // 印を付けて書き換えた仕事が、印の期限（dispatch か結果不明の行の lockUntil の最後）までに終わっていなければ、
      // 印の切れた後に写したかもしれない（その間の C-STORE を写しが黙って上書きしうる。BFF が仕事を待つ間に止まれば
      // 付け直しも止まる）。期限か仕事の終わりの時刻を読めなければ確かめられないので、同じく元を消さずに部分反映として
      // 人に見せる。照らし合わせが付け直した印の行（dispatch より後）は、書き換えの印に数えない
      const history = rows.filter(r => r.detail?.writeId === d.writeId);
      const lockedWrite = history.slice(0, history.indexOf(dispatch)).some(r => r.detail?.event === "lock");
      const lockUntil = history.filter(r => typeof r.detail?.lockUntil === "string").at(-1)?.detail?.lockUntil;
      const until = typeof lockUntil === "string" ? Date.parse(lockUntil) : NaN;
      const completed = job.completionTime ? Date.parse(job.completionTime) : NaN;
      const copiedAfterLock = lockedWrite
        && (!Number.isFinite(until) || !Number.isFinite(completed) || completed + 1000 > until);
      if (job.state === "Success" && copiedAfterLock) {
        removed = { lockLost: true };
      } else if (job.state === "Success" && d.after[0]!.PatientID !== d.before[0]!.PatientID) {
        const lock = (await backend.lookupStudyIds(d.StudyInstanceUID)).includes(d.oldOrthancId)
          ? await lockSource(backend, d.oldOrthancId, options, ttlSeconds => audit({
            actorId: "hl7-receiver",
            actorRole: "system",
            authMode: "hl7",
            action: "hl7",
            outcome: "success",
            patientId: d.before[0]!.PatientID,
            studyInstanceUid: d.StudyInstanceUID,
            detail: { event: "lock", writeId: d.writeId, oldOrthancId: d.oldOrthancId, ttlSeconds }
          })) : undefined;
        try {
          removed = await removeSource(backend, d, lock);
          // 最後に消す間に切れていれば（その間に届き直した画像を消したかもしれない）、成功にしない
          if (lock?.lost()) {
            removed = { ...removed, lockLost: true };
          }
        } catch (e) {
          // 消す途中で印が切れた・付け直せなかったら、残りを消さずに部分反映として人に見せる
          if (!lock?.lost()) {
            throw e;
          }
          removed = { lockLost: true };
        } finally {
          await lock?.release();
        }
      }
      const checked = await verify(backend, d);
      const success = job.state === "Success" && checked.matchesAfter && !removed.arrivalsLost && !removed.foreignCopies && !removed.lockLost;
      // Success の不一致は、前の値と同じでも自動で解かない（design.md §4）。
      const partial = !success && (job.state === "Success" || !checked.matchesBefore);
      const row: HistoryRow = {
        actorId: "hl7-receiver",
        actorRole: "system",
        authMode: "hl7",
        action: "hl7",
        outcome: success ? "success" : "failed",
        detail: { ...d, event: "reconcile", partial, ...checked, ...removed }
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
  /** 付け替えの印の期限と、印を付けてから元の検査を読むまで待つ時間（試験で縮める。design.md §15.4） */
  lockTtlMs?: number;
  lockSettleMs?: number;
  /** Orthanc の時計とのずれの許し（試験で期限を縮めるときに 0 にする。既定は LOCK_CLOCK_TOLERANCE_MS） */
  lockClockToleranceMs?: number;
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
  const { id, before, after } = plan;
  if (before.every((p, i) => values.every(k => p[k] === after[i]![k]))) {
    return false;
  }
  if (after[0]!.PatientID === before[0]!.PatientID) {
    return await writeStudy(backend, plan, messageId, row, options);
  }
  // 患者 ID の変わる書き換え（A40・見回り）は元の検査が残り、後で元の画像を消す。書き換えの前から消し終えるまで、元の
  // 検査に付け替えの印を付け、同じ StudyInstanceUID の C-STORE を Orthanc に断らせる（design.md §15.4）
  const writeId = randomUUID();
  const lock = await lockSource(backend, id, options, ttlSeconds =>
    row("lock", "success", { writeId, oldOrthancId: id, ttlSeconds }, before[0]!.PatientID, before[0]!.StudyInstanceUID));
  try {
    // モックは画像を受け取らないので待たない
    await new Promise(r => setTimeout(r, options.lockSettleMs ?? (backend.mock ? 0 : LOCK_SETTLE_MS)));
    return await writeStudy(backend, plan, messageId, row, options, writeId, lock);
  } finally {
    await lock.release();
  }
}
async function writeStudy(
  backend: Backend,
  plan: ReturnType<typeof planStudy> & { alongside?: PatientInstance[] },
  messageId: string,
  row: AuditRow,
  options: ProcessOptions,
  writeId: string = randomUUID(),
  lock?: SourceLock,
): Promise<boolean> {
  const { id, before, after, replace, alongside } = plan;
  // 患者 ID の変わる書き換えは、後で元の画像を消すので、書き換えの前のファイルの印を残す（design.md §15.4）
  const sourceFiles = lock ? await backend.studyInstanceFiles(id) : undefined;
  // 照合（planStudy）の後・印を付ける前に、同じ UID の画像が別の値で置き換わっていれば、その画像を照合していない。
  // 印を付けた後（C-STORE はもう入らない）に読み直し、照合した画像と同じでなければ書き換えない
  if (lock && !sameInstances(await backend.studyInstanceTags(id), before)) {
    throw new BackendError("書き換えの前に検査の画像が変わった");
  }
  const d: WriteDetail = {
    writeId,
    messageId,
    oldOrthancId: id,
    StudyInstanceUID: before[0]!.StudyInstanceUID,
    before,
    after,
    ...(alongside?.length ? { alongside } : {}),
    ...(sourceFiles ? { sourceFiles } : {})
  };
  // 元の検査を読む間に印が切れた・付け直せなかったら、その間の C-STORE を写しうるので、書き換えを始めない
  await lock?.ensure();
  await row("request", "success", { ...d }, after[0]!.PatientID, d.StudyInstanceUID);
  let state: string | undefined;
  let refusal: string | undefined;
  let jobCreated = false;
  try {
    // request を残す間に切れていても始めない（Orthanc に断られたときと同じく、書き換えなかった失敗として残す）
    if (lock?.lost()) {
      throw new BackendError("付け替えの印が切れたかもしれないので、書き換えを始めなかった");
    }
    const { jobId } = await backend.modifyStudyKeepingUids(id, replace);
    jobCreated = true;
    // 照らし合わせが、仕事がこの期限より後に終わったかを確かめられるよう、印の期限を残す（BFF が仕事を待つ間に止まると、
    // 付け直しも止まる）
    await row("dispatch", "success", { writeId: d.writeId, jobId, ...(lock ? { lockUntil: new Date(lock.until()).toISOString() } : {}) });
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
      await lock?.renew();
    }
  } catch (e) {
    // 仕事ができて写しているかもしれない（仕事を作った後か、書き換えを求めた答えが来なかった。Orthanc が断ったと分かる
    // BackendError だけが、仕事の無いことを示す）
    const mayCopy = jobCreated || !(e instanceof BackendError);
    if (mayCopy && lock?.lost()) {
      // 仕事の間に印が切れた・付け直せなかった：その間の C-STORE を写しが黙って上書きしえたので、照らし合わせで
      // 自動に解かず、元を消さずに部分反映として人に見せる（design.md §15.4）
      await lock.keep();
      await row("result", "failed", {
        ...d, partial: true, lockLost: true, reason: visible(e instanceof Error ? e.message : "付け替えの印が切れた")
      }, after[0]!.PatientID, d.StudyInstanceUID);
      throw new BackendError("付け替えの印が途中で切れた");
    }
    if (mayCopy) {
      // 仕事がまだ写しているかもしれないので、印は外さずに期限で切れるのを待つ。照らし合わせは、仕事がこの期限より
      // 後に終わっていれば元を消さない
      await lock?.keep();
      await row("result", "unknown", {
        ...d,
        ...(lock ? { lockUntil: new Date(lock.until()).toISOString() } : {}),
        reason: visible(e instanceof Error ? e.message : "応答不明")
      });
      throw e;
    }
    state = "Failure";
    refusal = e.message;
  }
  let checked;
  // 患者 ID の変わる書き換え（A40）だけ、元の検査が残る。書き換えた画像を確かめてから元の画像を名指しで消す（design.md §15）
  let removed: RemoveOutcome = {};
  try {
    if (state === "Success" && lock) {
      // 仕事を待つ間に印が切れていれば、元を消さない
      removed = lock.lost() ? { lockLost: true } : await removeSource(backend, d, lock);
      // 最後に消す間に切れていれば（その間に届き直した画像を消したかもしれない）、成功にしない
      if (lock.lost()) {
        removed = { ...removed, lockLost: true };
      }
    }
  } catch (e) {
    if (lock?.lost()) {
      // 消す途中で印が切れた・付け直せなかった：残りは消さず、部分反映として人に見せる
      removed = { lockLost: true };
    } else {
      await row("result", "unknown", { ...d, reason: visible(e instanceof Error ? e.message : "元の画像を消せなかった") });
      throw e;
    }
  }
  try {
    checked = await verify(backend, d);
  } catch (e) {
    await row("result", "unknown", { ...d, reason: "画像ごとの確かめに失敗した" });
    throw e;
  }
  const success = state === "Success" && checked.matchesAfter && !removed.arrivalsLost && !removed.foreignCopies && !removed.lockLost;
  // 成功した仕事の不一致は部分反映として止め、人の確認を待つ（design.md §4）。
  const partial = !success && (state === "Success" || !checked.matchesBefore);
  await row("result", success ? "success" : "failed", {
    ...d,
    ...checked,
    ...removed,
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
