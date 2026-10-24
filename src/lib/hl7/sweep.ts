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

type Alias = Extract<Remembered, { kind: "alias" }>;
type Order = Extract<Remembered, { kind: "order" }>;

export interface SweepResult {
  /** 書き換えた検査の数 */
  count: number;
  /** 書き換えずに残した検査の数（覚えに無い Study・氏名の違い・別の患者の同じ UID など） */
  skipped: number;
  /** 書き換えを止めた理由（解いていない書き換えがある・検証モード）。止めなければ undefined */
  blocked?: string;
}

/** 期限の中の覚えを、受理した順に取り出す。ack の行の AA だけを見る。 */
export function activeMemory(rows: HistoryRow[], now: number): { aliases: Alias[]; orders: Order[] } {
  const remembered = rows
    .filter(r => r.detail?.event === "ack" && r.detail?.code === "AA" && r.detail?.remember)
    .map(r => r.detail!.remember as Remembered)
    .filter(m => {
      const at = Date.parse(m.at);
      // 時計の小さな巻き戻り（5 分まで）は許す。それより先の時刻の覚えは使わない
      return Number.isFinite(at) && at - now <= 5 * 60 * 1000 && now - at <= REMEMBER_TTL_MS;
    });
  return {
    aliases: remembered.filter((m): m is Alias => m.kind === "alias"),
    orders: remembered.filter((m): m is Order => m.kind === "order"),
  };
}

/**
 * 仮の患者 ID から、統合の続き（仮→正→別の正）をたどって、いまの患者 ID を決める。
 * 同じ患者 ID から 2 つ以上の先がある・輪になっているときは、どれか決められないので null（書き換えない）。
 * 続きの統合は、前の統合より後に受理したものだけをたどる。
 */
export function resolveAlias(aliases: Alias[], start: string): Alias[] | null {
  const links: Alias[] = [];
  const seen = new Set([start]);
  let current = start;
  let since = Number.NEGATIVE_INFINITY;
  for (;;) {
    const next = aliases.filter(a => a.from === current && Date.parse(a.at) >= since);
    const targets = new Set(next.map(a => a.to));
    if (!targets.size) {
      break;
    }
    if (targets.size > 1) {
      return null;
    }
    const link = next.at(-1)!;
    if (seen.has(link.to)) {
      return null;
    }
    seen.add(link.to);
    links.push(link);
    current = link.to;
    since = Date.parse(link.at);
  }
  return links.length ? links : null;
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
  const { aliases, orders } = activeMemory(rows, now);
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
      for (const id of await backend.findStudiesByPatientId(source)) {
        skip("統合の先を決められない", source, id);
      }
      continue;
    }
    const target = links.at(-1)!.to;
    const chain = new Set(links.map(l => l.to));
    const first = Date.parse(links[0]!.at);
    const relevantOrders = orders.filter(o => chain.has(o.patientId) && Date.parse(o.at) >= first);
    const known = new Set([...links.flatMap(l => l.studies), ...relevantOrders.map(o => o.uid)]);
    const fromNames = links[0]!.fromNames;
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
      if (fromNames.length && before.some(i => !fromNames.includes(i.PatientName))) {
        skip("統合の前の氏名と違う", source, uid);
        continue;
      }
      const others = (await backend.lookupStudyIds(uid)).filter(other => other !== id);
      const alongside = (await Promise.all(others.map(other => backend.studyInstanceTags(other)))).flat();
      if (alongside.some(i => i.PatientID !== target)) {
        skip("同じ StudyInstanceUID の検査が別の患者にある", source, uid);
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
