/* eslint-disable no-control-regex -- ASCII と制御文字の検証。 */
import "server-only";
import { randomUUID } from "node:crypto";
import { appendAudit, verifyAuditChain, type AuditAction, type AuditEntryInput, type AuditOutcome, type AuditRow as StoredAuditRow } from "@/lib/audit";
import { readAuditAnchors } from "@/lib/audit-anchor";
import { getDb } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { BackendError, BackendUnknownError, LOCK_CLOCK_TOLERANCE_MS, type Backend, type PatientInstance, type SourceFiles } from "@/lib/backend/types";
import { visible } from "../../hl7-receiver/visible";

// UID を保つ書き換えの部品（openspec/changes/add-study-value-correction/design.md の 2）。HL7 による患者情報の更新
// （src/lib/hl7/apply.ts）から切り出したもの。Study・Series・SOP Instance UID を保ったまま、患者の属性と受付番号を
// 書き換え、書き換えの後に全部の画像を確かめ、結果不明・部分反映を照らす。患者 ID の変わる書き換えは、付け替えの印を
// 付けてから書き換え、書き換えた画像を確かめてから元の画像を名指しで消す。
// 書き換えの経過は監査の記録の行（detail の event・writeId）に残し、その行だけから照らし合わせを決める。
// 文中の design.md §n は、HL7 の設計（openspec/changes/archive/2026-10-24-add-hl7-patient-update-receiver/design.md）の節。

export type AuditWriter = (input: AuditEntryInput) => Promise<unknown>;

export type HistoryRow = AuditEntryInput & {
  occurredAt?: Date;
};
export const writeAudit: AuditWriter = async (input) => appendAudit(await getDb(), input);
/** 監査の記録の書き換えの行が、鍵つきの値とつなぎに合わない（書き換えられた・差し込まれた）。人が確かめるまで処理しない */
export class HistoryTampered extends BackendUnknownError {
  constructor(seq: number, reason: string) {
    super(`監査の記録が鍵つきの値・つなぎと合わない（seq ${seq}：${reason}）`);
  }
}
/**
 * 書き換えの経過を残す監査の記録の操作。HL7 による更新（hl7）と、画面の値の修正（modify）の両方を読み、どちらかの
 * 結果不明・部分反映が残るあいだは、両方の書き換えを止める（openspec/changes/add-study-value-correction/design.md の 2）
 */
const WRITE_ACTIONS: readonly AuditAction[] = ["hl7", "modify"];
/**
 * 監査の一本のつなぎから、書き換えの経過を古い順に読む（design.md §13）。つなぎの全部を確かめ（行の action を書き換えて
 * 書き換えの行を隠されても見つける）、確かめた行のうち書き換えの操作の行だけを返す（確かめた後に読み直さない。design.md §15.1）。
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
      if ((WRITE_ACTIONS as readonly string[]).includes(row.action)) rows.push(row);
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
    return { ...r, action: r.action as AuditAction, outcome: r.outcome as AuditOutcome, detail };
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
/** UID を保つ書き換えで書き換え・確かめる値 */
export const KEEP_UID_VALUES = [
  "PatientID",
  "PatientName",
  "PatientBirthDate",
  "PatientSex",
  "AccessionNumber"
] as const;
const values = KEEP_UID_VALUES;
export const triple = (r: PatientInstance) => [r.StudyInstanceUID, r.SeriesInstanceUID, r.SOPInstanceUID].join("|");

export interface WriteDetail {
  writeId: string;
  /** 書き換えを求めたもの（HL7 はメッセージの ID、見回りはその回の ID） */
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
  /**
   * 複数の検査をまとめた書き換えの組（画面の、同じ患者の全部の検査への属性の訂正）の、組の全部の StudyInstanceUID。
   * 組は event が group の行で始め、全部の検査を書き換え終えたら result の行で閉じる。閉じていない（途中で止まった）・
   * 部分反映・結果不明の組は、管理者が解くまで残る（照らし合わせは、組を自動では解かない。仕事の行が無いため）。
   * 組の before と after は空
   */
  group?: string[];
}
/** 人が解くまで、期限を設けず結果不明と部分反映を拾う（design.md §10）。書き換えの組（group）も同じく拾う */
export function unresolved(rows: HistoryRow[]): WriteDetail[] {
  return rows.filter(r => r.detail?.event === "request" || r.detail?.event === "group").map(r => r.detail as unknown as WriteDetail).filter(d => {
    const last = rows.filter(r => r.detail?.writeId === d.writeId && ["result", "reconcile"].includes(String(r.detail?.event))).at(-1);
    return !last || (last.detail?.manual !== true && (last.outcome === "unknown" || last.detail?.partial === true));
  });
}
/** 画像の集まりが、UID の組と患者の値で過不足なく同じか。どちらかに UID の組の重なりがあれば同じとしない */
export function sameInstances(actual: PatientInstance[], expected: PatientInstance[]): boolean {
  if (!actual.length || actual.length !== expected.length) {
    return false;
  }
  if (new Set(expected.map(triple)).size !== expected.length || new Set(actual.map(triple)).size !== actual.length) {
    return false;
  }
  return expected.every(e => actual.some(a => triple(a) === triple(e) && values.every(k => a[k] === e[k])));
}
/**
 * 書き換える検査の画像を確かめる。画像が無い・UID の組が欠ける・重なる・StudyInstanceUID が揃わない・
 * 患者の値と受付番号が画像どうしで揃わないときは投げる。uniform が false なら、患者 ID のほかの値の揃いは見ない
 * （画面の属性の訂正は、部分反映で値の揃わなくなった検査を、人が確かめて揃え直すのにも使うため）
 */
export function checkStudyInstances(before: PatientInstance[], uniform = true): PatientInstance {
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
  if (before.some(x => (uniform ? values : ["PatientID"] as const).some(k => x[k] !== p[k]))) {
    throw new BackendError("画像どうしで属性が揃っていない");
  }
  return p;
}
/** ASCII の外の文字（日本語など）は、文字の集合が ISO_IR 192 の検査だけに書き込む */
export function checkCharset(replace: Record<string, string>, before: PatientInstance[]): void {
  if (Object.values(replace).some(v => /[^\x00-\x7f]/u.test(v)) && before.some(p => p.SpecificCharacterSet !== "ISO_IR 192")) {
    throw new BackendError("日本語は ISO_IR 192 の検査だけに書き込める");
  }
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
  /** 途中の付け直しの答えを待ってから lost を返す（消し終えた後に、印が続いていたかを決めるとき） */
  settledLost(): Promise<boolean>;
  /** いまの期限（ミリ秒の時刻） */
  until(): number;
  /**
   * 付け直しを止め、印は外さずに期限で切れるのを待つ（仕事の終わりを読めないとき。仕事が写している間に外さない）。
   * この後の release は印を外さない
   */
  keep(): Promise<void>;
  /**
   * 付け直しを止めて印を外す（keep の後は外さない）。止めるまで印が切れずに続いていた（途中の付け直しも失敗しなかった）か
   * を返す。外せなくても投げない（期限で切れる）
   */
  release(): Promise<boolean>;
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
  // 書いた期限（この機の時計の時刻。記録と照らし合わせに使う）と、同じ期限の単調な時計の上の値（切れたかを見る）
  let until = 0;
  let untilMono = 0;
  // Lua は Orthanc の時計で比べる。lockStudy が付けるたびに時計のずれを margin の内と確かめるので、期限の margin 前から
  // 切れたとみなす。切れたかは単調な時計で見る（付けた後にこの機の時計が巻き戻っても、切れを見逃さない）
  const margin = options.lockClockToleranceMs ?? LOCK_CLOCK_TOLERANCE_MS;
  const expired = () => untilMono > 0 && performance.now() >= untilMono - margin;
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
    if (untilMono - performance.now() > ttl / 2) {
      return;
    }
    const next = Date.now() + ttl;
    const nextMono = performance.now() + ttl;
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
    untilMono = nextMono;
  };
  await renew();
  // 仕事を待つ間・元の検査を読む間・写しを確かめる間も切らさないように、期限の 4 分の 1 ごとに付け直す
  const timer = setInterval(() => void renew().catch(() => undefined), Math.max(ttl / 4, 10));
  timer.unref?.();
  let kept = false;
  let releasing: Promise<boolean> | undefined;
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
    settledLost: async () => {
      await pending?.catch(() => undefined);
      return failure !== undefined || (!released && expired());
    },
    until: () => until,
    keep: async () => {
      kept = true;
      await stop();
    },
    // 2 回目からは 1 回目の答えを返す（外すのは 1 回）
    release: () => releasing ??= (async () => {
      // 止める時に切れていなかったか（止めた後は期限を見ない）と、途中の付け直しの答えを合わせて、外すまで続いていたかを決める
      const expiredAtStop = !released && expired();
      await stop();
      let held = failure === undefined && !expiredAtStop;
      // 印の間に Orthanc の時計が進んでいれば（付けた時に確かめたずれから外れていれば）、Lua は印を切れたと読んだかもしれない
      if (held) {
        try {
          await backend.checkLockClock();
        } catch {
          held = false;
        }
      }
      if (kept) {
        return held;
      }
      try {
        await backend.unlockStudy(id);
      } catch {
        console.warn("付け替えの印を外せなかった（期限で切れる）");
      }
      return held;
    })()
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
  // 最中に届いた画像の消失を見つけた後は、この確かめが失敗しても見つけたことを失わない（部分反映として返す）
  try {
    if (named.length && !await copiesFromSource()) {
      outcome.foreignCopies = true;
    }
  } catch (e) {
    if (!outcome.arrivalsLost) {
      throw e;
    }
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
/** 照らし合わせの行を書く主体（HL7 の受け口と同じ、システムの主体） */
const SYSTEM_ACTOR = { actorId: "hl7-receiver", actorRole: "system", authMode: "hl7" } as const;
/** 書き換えの「求めた」の行の操作（照らし合わせの行は、同じ操作の行として書く） */
function writeAction(rows: HistoryRow[], writeId: string): AuditAction {
  return rows.find(r => (r.detail?.event === "request" || r.detail?.event === "group") && r.detail?.writeId === writeId)?.action ?? "hl7";
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
    const action = writeAction(rows, d.writeId);
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
            ...SYSTEM_ACTOR,
            action,
            outcome: "success",
            patientId: d.before[0]!.PatientID,
            studyInstanceUid: d.StudyInstanceUID,
            detail: { event: "lock", writeId: d.writeId, oldOrthancId: d.oldOrthancId, ttlSeconds }
          })) : undefined;
        try {
          removed = await removeSource(backend, d, lock);
        } catch (e) {
          // 消す途中で印が切れた・付け直せなかったら（印を外し、途中の付け直しの答えと Orthanc の時計のずれも見て決める）、
          // 残りを消さずに部分反映として人に見せる
          if (!lock || await lock.release()) {
            throw e;
          }
          removed = { lockLost: true };
        } finally {
          // 外すまでに切れていれば（最後に消す間に届き直した画像を消したかもしれない）、成功にしない。確かめはこの後
          if (lock && !await lock.release()) {
            removed = { ...removed, lockLost: true };
          }
        }
      }
      // 元を消す間の異常を見つけた後は、確かめに失敗しても解かずに残さず、部分反映として人に見せる
      const anomaly = Boolean(removed.arrivalsLost || removed.foreignCopies || removed.lockLost);
      const checked = await verify(backend, d).catch((e: unknown) => {
        if (!anomaly) throw e;
        return undefined;
      });
      const success = checked !== undefined && job.state === "Success" && checked.matchesAfter && !anomaly;
      // Success の不一致は、前の値と同じでも自動で解かない（design.md §4）。
      const partial = !success && (job.state === "Success" || !checked?.matchesBefore);
      const row: HistoryRow = {
        ...SYSTEM_ACTOR,
        action,
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

/** 1 つの検査の書き換えの段取り（Orthanc の中の検査の ID・書き換える前と後の画像・Orthanc に渡す値） */
export interface KeepUidPlan {
  id: string;
  before: PatientInstance[];
  replace: Record<string, string>;
  after: PatientInstance[];
  alongside?: PatientInstance[];
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
  plan: KeepUidPlan,
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
  plan: KeepUidPlan,
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
    // 途中の付け直しの答えも待つ
    if (mayCopy && lock && await lock.settledLost()) {
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
  let checked: Awaited<ReturnType<typeof verify>> | undefined;
  // 患者 ID の変わる書き換え（A40）だけ、元の検査が残る。書き換えた画像を確かめてから元の画像を名指しで消す（design.md §15）
  let removed: RemoveOutcome = {};
  try {
    if (state === "Success" && lock) {
      // 仕事を待つ間に印が切れていれば、元を消さない
      removed = lock.lost() ? { lockLost: true } : await removeSource(backend, d, lock);
      // 外すまでに切れていれば（最後に消す間に届き直した画像を消したかもしれない）、成功にしない。照らし合わせと同じく、
      // 外してから確かめる（確かめる間の付け直しの失敗で、結果が揺れない）
      if (!await lock.release()) {
        removed = { ...removed, lockLost: true };
      }
    }
  } catch (e) {
    // 印を外し、外すまで続いていたか（途中の付け直しの答えと Orthanc の時計のずれも）で決める
    if (lock && !await lock.release()) {
      // 消す途中で印が切れた・付け直せなかった：残りは消さず、部分反映として人に見せる
      removed = { lockLost: true };
    } else {
      await row("result", "unknown", { ...d, reason: visible(e instanceof Error ? e.message : "元の画像を消せなかった") });
      throw e;
    }
  }
  // 元を消す間の異常（印の切れ・写しの置き換わり・最中に届いた画像の消失）を見つけた後は、確かめに失敗しても結果不明に
  // 戻さず（照らし合わせが自動で解きうる）、部分反映として人に見せる
  const anomaly = Boolean(removed.arrivalsLost || removed.foreignCopies || removed.lockLost);
  try {
    checked = await verify(backend, d);
  } catch (e) {
    if (!anomaly) {
      await row("result", "unknown", { ...d, reason: "画像ごとの確かめに失敗した" });
      throw e;
    }
  }
  const success = checked !== undefined && state === "Success" && checked.matchesAfter && !anomaly;
  // 成功した仕事の不一致は部分反映として止め、人の確認を待つ（design.md §4）。
  const partial = !success && (state === "Success" || !checked?.matchesBefore);
  await row("result", success ? "success" : "failed", {
    ...d,
    ...checked,
    ...removed,
    partial,
    state,
    reason: refusal ? visible(refusal) : checked ? undefined : "画像ごとの確かめに失敗した"
  }, after[0]!.PatientID, d.StudyInstanceUID);
  if (!success) {
    throw new BackendError(partial ? "画像の一部だけが書き換わった" : refusal ?? "書き換わらなかった");
  }
  return true;
}
