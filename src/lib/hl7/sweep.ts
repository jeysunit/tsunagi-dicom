import "server-only";
import { randomUUID } from "node:crypto";
import { getConfig } from "@/lib/config";
import { getBackend } from "@/lib/backend";
import { BackendError, type Backend, type PatientInstance } from "@/lib/backend/types";
import { visible } from "../../../hl7-receiver/visible";
import {
  history,
  planStudy,
  reconcile,
  writeAndVerify,
  writeAudit,
  type AuditRow,
  type AuditWriter,
  type HistoryRow,
  type ProcessOptions,
  type Remembered,
} from "./apply";

/** A40・ORM の覚えを使う期間。受理から 24 時間（design.md §15） */
export const REMEMBER_TTL_MS = 24 * 60 * 60 * 1000;
/** BFF の時計の巻き戻りを許す幅（design.md §15.2） */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 覚えに、受理した順（監査の記録の並び）と受理の時刻を添えたもの。前後は順で決め、時刻は期限だけに使う */
type Ordered<T> = T & { seq: number; time: number };
type Alias = Ordered<Extract<Remembered, { kind: "alias" }>>;
type Order = Ordered<Extract<Remembered, { kind: "order" }>>;

export interface SweepResult {
  /** 書き換えた検査の数 */
  count: number;
  /** 書き換えずに残した検査の数（覚えに無い Study・氏名の違い・別の患者の同じ UID など） */
  skipped: number;
  /** 書き換えを止めた理由（解いていない書き換えがある・検証モード）。止めなければ undefined */
  blocked?: string;
}

/**
 * 覚えを、受理した順に全部取り出す（ack の行の AA だけ）。期限はここでは切らない。統合の段と前後は全部の覚えで
 * 決めてから、最初の段の時刻で期限を見る（期限で古い A40 だけが落ちて、送り直しが新しい段に見えることを防ぐ）。
 */
export function memory(rows: HistoryRow[]): { aliases: Alias[]; orders: Order[] } {
  const remembered = rows
    .filter(r => r.detail?.event === "ack" && r.detail?.code === "AA" && r.detail?.remember)
    .map((r, seq) => {
      const m = r.detail!.remember as Remembered;
      return { ...m, seq, time: Date.parse(m.at) };
    })
    .filter(m => Number.isFinite(m.time));
  return {
    aliases: remembered.filter((m): m is Alias => m.kind === "alias"),
    orders: remembered.filter((m): m is Order => m.kind === "order"),
  };
}

/** 統合の最初の段の A40 が、期限（受理から 24 時間）の中か。時計の小さな巻き戻り（5 分まで）は許す */
export function withinTtl(link: { time: number }, now: number): boolean {
  return link.time - now <= CLOCK_SKEW_MS && now - link.time <= REMEMBER_TTL_MS;
}

/** 統合の 1 段。同じ旧い患者 ID から同じ先への A40（送り直しを含む）をまとめたもの */
export interface Link {
  from: string;
  to: string;
  /** その段の最初の A40 の受理の順と時刻 */
  seq: number;
  time: number;
  studies: string[];
  fromNames: string[];
  fromBirthDates: string[];
  fromSexes: string[];
  /** その段の最後の A40 の、統合した先の患者の値 */
  attributes: Record<string, string>;
}

/**
 * 仮の患者 ID から、統合の続き（仮→正→別の正）をたどって、いまの患者 ID を決める。
 * 同じ患者 ID から 2 つ以上の先がある・輪になっているときは、どれか決められないので null（書き換えない）。
 * 続きの統合は、前の段の最初の A40 より後に受理したものだけをたどる。同じ先への A40 の送り直し（別の MSH-10）は
 * 1 つの段にまとめ、最初の A40 の検査・氏名・時刻を失わない。
 */
export function resolveAlias(aliases: Alias[], start: string): Link[] | null {
  const links: Link[] = [];
  const seen = new Set([start]);
  let current = start;
  let since = Number.NEGATIVE_INFINITY;
  for (;;) {
    const next = aliases.filter(a => a.from === current && a.seq > since);
    const targets = new Set(next.map(a => a.to));
    if (!targets.size) {
      break;
    }
    if (targets.size > 1) {
      return null;
    }
    const to = next[0]!.to;
    if (seen.has(to)) {
      return null;
    }
    const union = (pick: (a: Alias) => string[] | undefined) => [...new Set(next.flatMap(a => pick(a) ?? []))];
    const link: Link = {
      from: current,
      to,
      seq: next[0]!.seq,
      time: next[0]!.time,
      studies: union(a => a.studies),
      fromNames: union(a => a.fromNames),
      fromBirthDates: union(a => a.fromBirthDates).filter(Boolean),
      fromSexes: union(a => a.fromSexes).filter(Boolean),
      attributes: next.at(-1)!.attributes
    };
    seen.add(to);
    links.push(link);
    current = to;
    since = link.seq;
  }
  return links.length ? links : null;
}

/**
 * 統合の先の患者の ORM のうち、使ってよいもの。その段の最初の A40 の後で、次の段（その患者がさらに別の患者に
 * 統合された）の最初の A40 より前に受理したものだけ（前後は受理した順で決める）。統合された後の患者 ID の ORM は、
 * 別の患者のものでありうる。
 */
export function ordersForChain(links: Link[], orders: Order[]): Order[] {
  return orders.filter(o => links.some((link, i) => {
    const until = links[i + 1]?.seq ?? Number.POSITIVE_INFINITY;
    return o.patientId === link.to && o.seq > link.seq && o.seq < until;
  }));
}

function uniform(instances: PatientInstance[], keys: (keyof PatientInstance)[]): boolean {
  return instances.every(i => keys.every(k => i[k] === instances[0]![k]));
}

/**
 * 照合（A40）の後に、仮の患者 ID のまま届いた画像を、統合した先の患者に書き換える（IHE PIR の Case 6。design.md §15）。
 * 書き換えるのは、期限の中の A40 の覚えがある仮の患者 ID の検査のうち、StudyInstanceUID がその A40 で書き換えた検査か、
 * 統合した先の患者の ORM で知らされた検査で、届き終えた（Orthanc の IsStable）ものだけ。
 * 書き方は A40 と同じ（UID を保ち、元の検査を消す。監査の記録を通し、仕事の終わりと全画像を確かめる）。
 */
export async function sweepArrivals(
  backend: Backend = getBackend(),
  audit: AuditWriter = writeAudit,
  options: ProcessOptions & { now?: () => number } = {},
): Promise<SweepResult> {
  if (!(options.allowWrite ?? (getConfig().auth.mode !== "dev" || getConfig().auth.devAllowWrite))) {
    return { count: 0, skipped: 0, blocked: "検証モードの書き込みが許可されていない" };
  }
  const rows = [...await (options.readHistory ?? history)()];
  if (!await reconcile(backend, rows, audit)) {
    return { count: 0, skipped: 0, blocked: "結果の分からない書き換えがある" };
  }
  const now = (options.now ?? Date.now)();
  const { aliases, orders } = memory(rows);
  // 時計が 5 分より大きく戻ったときは、どの覚えを使ってよいか決められないので、時計が追いつくまで書き換えない
  if ([...aliases, ...orders].some(m => m.time - now > CLOCK_SKEW_MS)) {
    return { count: 0, skipped: 0, blocked: "覚えの時刻が BFF の時計より先にある（時計が戻った）" };
  }
  const sweepId = randomUUID();
  const row: AuditRow = (event, outcome, detail = {}, patientId, studyInstanceUid) => audit({
    actorId: "hl7-receiver",
    actorRole: "system",
    authMode: "hl7",
    action: "hl7",
    outcome,
    patientId,
    studyInstanceUid,
    detail: { messageId: sweepId, type: "sweep", event, ...detail }
  });
  const result: SweepResult = { count: 0, skipped: 0 };
  // 書き換えなかった検査は、見回りのたびに同じものが出るので、監査の記録ではなくログに残す
  const skip = (reason: string, patientId: string, uid: string) => {
    result.skipped++;
    console.warn(`HL7 の照合の後の画像を書き換えなかった：${visible(reason)}（${visible(patientId)}・${visible(uid)}）`);
  };
  for (const source of [...new Set(aliases.map(a => a.from))]) {
    const links = resolveAlias(aliases, source);
    if (!links) {
      // 期限の中の A40 があるときだけ知らせる（古い覚えのたびに Orthanc を探さない）
      if (aliases.some(a => a.from === source && withinTtl(a, now))) {
        for (const id of await backend.findStudiesByPatientId(source)) {
          skip("統合の先を決められない", source, id);
        }
      }
      continue;
    }
    if (!withinTtl(links[0]!, now)) {
      continue;
    }
    const target = links.at(-1)!.to;
    const head = links[0]!;
    const relevantOrders = ordersForChain(links, orders);
    // 仮の患者の検査と分かるのは、最初の段の A40 で書き換えた検査と、最初の段の先の患者の ORM の検査だけ。
    // 後の段の先の患者の検査・ORM は、その患者のほかの検査でありうるので、仮の患者 ID の画像の相手にしない
    const known = new Set([...head.studies, ...relevantOrders.filter(o => o.patientId === head.to).map(o => o.uid)]);
    for (const id of await backend.findStudiesByPatientId(source)) {
      if (!await backend.studyIsStable(id)) {
        continue;
      }
      const before = await backend.studyInstanceTags(id);
      const uid = before[0]?.StudyInstanceUID ?? "";
      if (!known.has(uid)) {
        skip("統合した検査でも、統合した先の予約の検査でもない", source, uid);
        continue;
      }
      // 統合の前の画像と、氏名・生年月日・性別の空でない値が食い違えば、別の患者の画像でありうる
      if (head.fromNames.length && before.some(i => !head.fromNames.includes(i.PatientName))) {
        skip("統合の前の氏名と違う", source, uid);
        continue;
      }
      if (head.fromBirthDates.length && before.some(i => i.PatientBirthDate && !head.fromBirthDates.includes(i.PatientBirthDate))) {
        skip("統合の前の生年月日と違う", source, uid);
        continue;
      }
      if (head.fromSexes.length && before.some(i => i.PatientSex && !head.fromSexes.includes(i.PatientSex))) {
        skip("統合の前の性別と違う", source, uid);
        continue;
      }
      const others = (await backend.lookupStudyIds(uid)).filter(other => other !== id);
      const alongside = (await Promise.all(others.map(other => backend.studyInstanceTags(other)))).flat();
      if (alongside.some(i => i.PatientID !== target)) {
        skip("同じ StudyInstanceUID の検査が別の患者にある", source, uid);
        continue;
      }
      // 同じ画像（Study・Series・SOP の UID が同じ）の送り直しは、上書きになって確かめが合わないので書き換えない
      const sent = new Set(alongside.map(i => [i.StudyInstanceUID, i.SeriesInstanceUID, i.SOPInstanceUID].join("|")));
      if (before.some(i => sent.has([i.StudyInstanceUID, i.SeriesInstanceUID, i.SOPInstanceUID].join("|")))) {
        skip("統合した先の検査に同じ画像がすでにある", source, uid);
        continue;
      }
      // 統合した先の患者の値は、Orthanc のいまの値を使う（A40 の後の A08 を巻き戻さない）。無ければ A40 の値
      const targetIds = await backend.findStudiesByPatientId(target);
      const basis = (await Promise.all(targetIds.map(t => backend.studyInstanceTags(t)))).flat();
      if (basis.length && !uniform(basis, ["PatientName", "PatientBirthDate", "PatientSex"])) {
        skip("統合した先の患者の検査どうしで属性が揃っていない", source, uid);
        continue;
      }
      const attributes = basis.length
        ? { PatientName: basis[0]!.PatientName, PatientBirthDate: basis[0]!.PatientBirthDate, PatientSex: basis[0]!.PatientSex }
        : links.at(-1)!.attributes;
      // 先の患者に検査が無い（A40 の時点で画像が無かった）とき、A40 の値の空の欄は、届いた画像の値のまま
      // 受付番号は、その検査の最後の ORM（CA・DC なら空）。無ければ、同じ検査のすでにある画像の値
      const order = relevantOrders.filter(o => o.uid === uid).at(-1);
      let accession = order
        ? (order.control === "CA" || order.control === "DC" ? "" : order.accession)
        : alongside.length && uniform(alongside, ["AccessionNumber"]) ? alongside[0]!.AccessionNumber : before[0]!.AccessionNumber;
      if (before[0]!.AccessionNumber && before[0]!.AccessionNumber !== accession) {
        skip("届いた画像に別の受付番号が入っている", source, uid);
        continue;
      }
      accession ||= "";
      let plan;
      try {
        plan = planStudy({ kind: "A40", patientId: target, priorPatientId: source, attributes }, attributes, id, before);
      } catch (e) {
        skip(e instanceof Error ? e.message : "画像の値が正しくない", source, uid);
        continue;
      }
      const replace = { ...plan.replace, AccessionNumber: accession };
      const merged = { ...plan, replace, after: before.map(p => ({ ...p, ...replace })), alongside };
      try {
        if (await writeAndVerify(backend, merged, sweepId, row, options)) {
          result.count++;
        }
      } catch (e) {
        // 書き換えの失敗・結果不明は監査の記録に残っている。次の書き換えは、照らせるまで止める
        result.blocked = e instanceof BackendError ? e.message : "書き換えに失敗した";
        return result;
      }
    }
  }
  return result;
}
