// ファイルを選ぶ部品（docs/design-system/parts.md の「ファイルを選ぶ部品」）の数え方・並び・文言。画面の部品
// （src/components/ui/file-picker.tsx）から呼ぶ、DOM を持たない関数だけを置く（Vitest で確認する）。
// 数え方は 1 つ：件 ＝ 対象外 ＋ 除外 ＋ 選択、選択 ＝ 成功 ＋ 失敗 ＋ 結果不明 ＋ 中止（インポート中は待ち・実行中も入る）。
// 結果不明は tsunagi で追加した状態（docs/design-system/parts.md の「tsunagi で決めたこと」）。受け手の答えが分からず、
// 成功とも失敗とも言えない行（docs/spec.md の 3.5 の「結果不明」）。

import { formatCount, formatSize, type PreviewTags } from "@/lib/import/dicom-preview";

/**
 * 行の状態。check＝確認中・wait＝インポート待ち・run＝インポート中・ok＝成功・ng＝失敗・uk＝結果不明・ex＝対象外・cx＝中止。
 * 除外は状態でなく off（利用者が外した印）で持つ（戻すと元の状態に戻る）
 */
export type PickState = "check" | "wait" | "run" | "ok" | "ng" | "uk" | "ex" | "cx";

/** 結果不明の行を確認して記録するときに BFF へ渡す識別子（インポートの要求の ID と、その検査の Study Instance UID） */
export interface ResolveTarget {
  requestId: string;
  studyInstanceUid: string;
}

export interface PickItem<F = File> {
  id: number;
  /** 同じファイルを見分ける鍵（場所つきの名前・大きさ・更新時刻） */
  key: string;
  file: F;
  name: string;
  /** フォルダの中なら、最後の / までの場所。無ければ空 */
  dir: string;
  size: number;
  state: PickState;
  /** 対象外・失敗・中止の理由の 1 句 */
  reason: string;
  /** 除外（利用者が外した） */
  off: boolean;
  tags: PreviewTags | null;
  /** 結果不明の行を管理者が確認して記録するための識別子。BFF に届いた要求だけが持つ（届いたか分からない行には無い） */
  resolve?: ResolveTarget;
  /** 結果不明の行を管理者が確認して記録した行（札は成功か失敗。結果の知らせに「うち K 件は管理者が確認」と数える） */
  confirmed?: boolean;
}

export type PickPhase = "idle" | "busy" | "done";

/** 追加するファイル。path は場所つきの名前（フォルダの中なら webkitRelativePath・ドロップの fullPath、無ければ名前） */
export interface PickInput<F = File> {
  file: F;
  path: string;
  size: number;
  lastModified: number;
}

/** 続けて選んだファイルを追加する（置き換えない）。同じファイルは 1 件のまま、追加しなかった数を返す */
export function addFiles<F>(items: readonly PickItem<F>[], inputs: readonly PickInput<F>[], nextId: number): { items: PickItem<F>[]; fresh: PickItem<F>[]; duplicates: number } {
  const seen = new Set(items.map((i) => i.key));
  const fresh: PickItem<F>[] = [];
  let duplicates = 0;
  let id = nextId;
  for (const input of inputs) {
    const path = input.path.replace(/^\/+/, "");
    const key = `${path}|${input.size}|${input.lastModified}`;
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const cut = path.lastIndexOf("/");
    fresh.push({
      id: id++,
      key,
      file: input.file,
      name: cut < 0 ? path : path.slice(cut + 1),
      dir: cut < 0 ? "" : path.slice(0, cut + 1),
      size: input.size,
      state: "check",
      reason: "",
      off: false,
      tags: null,
    });
  }
  return { items: [...items, ...fresh], fresh, duplicates };
}

/** インポートに回す行（選択） */
export const isSelected = (i: PickItem<unknown>) => !i.off && i.state !== "ex";

export interface PickCounts {
  /** 件（置いたもの全部） */
  total: number;
  excluded: number;
  removed: number;
  selected: number;
  selectedBytes: number;
  ok: number;
  ng: number;
  /** 成功・失敗のうち、管理者が確認して記録した行 */
  confirmedOk: number;
  confirmedNg: number;
  /** 結果不明 */
  unknown: number;
  cancelled: number;
  checking: number;
}

export function countItems(items: readonly PickItem<unknown>[]): PickCounts {
  const selected = items.filter(isSelected);
  return {
    total: items.length,
    excluded: items.filter((i) => !i.off && i.state === "ex").length,
    removed: items.filter((i) => i.off).length,
    selected: selected.length,
    selectedBytes: selected.reduce((s, i) => s + i.size, 0),
    ok: selected.filter((i) => i.state === "ok").length,
    ng: selected.filter((i) => i.state === "ng").length,
    confirmedOk: selected.filter((i) => i.state === "ok" && i.confirmed).length,
    confirmedNg: selected.filter((i) => i.state === "ng" && i.confirmed).length,
    unknown: selected.filter((i) => i.state === "uk").length,
    cancelled: selected.filter((i) => i.state === "cx").length,
    checking: items.filter((i) => i.state === "check").length,
  };
}

/**
 * 一覧の並び：失敗・結果不明→対象外→それ以外。同じ並びの中は選んだ順。除外した行は元の場所に残す（除外する前の状態で並べる）。
 * 結果不明は、失敗と同じく確認の要る行なので、失敗と同じ並びに置く
 */
export function sortForList<T extends PickItem<unknown>>(items: readonly T[]): T[] {
  const rank = (i: PickItem<unknown>) => (i.state === "ng" || i.state === "uk" ? 0 : i.state === "ex" ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || a.id - b.id);
}

/** 件数の行の括弧の中（対象外・除外。0 のものは出さない。両方 0 なら空） */
export function skippedNote(c: PickCounts): string {
  const parts = [c.excluded ? `対象外 ${formatCount(c.excluded)}` : "", c.removed ? `除外 ${formatCount(c.removed)}` : ""].filter(Boolean);
  return parts.length ? `（${parts.join("・")}）` : "";
}

/** 操作の行の左の 1 行 */
export function formbarText(phase: PickPhase, c: PickCounts): string {
  if (c.total === 0) return "ファイルを選択してください。";
  if (phase === "done") {
    const unknown = c.unknown ? `・結果不明 ${formatCount(c.unknown)}` : "";
    return `選択 ${formatCount(c.selected)} 件 → 成功 ${formatCount(c.ok)}・失敗 ${formatCount(c.ng)}${unknown}${c.cancelled ? `・中止 ${formatCount(c.cancelled)}` : ""}`;
  }
  if (c.selected === 0) return "インポートできるファイルがありません。";
  return `選択 ${formatCount(c.selected)} 件・${formatSize(c.selectedBytes)}`;
}

/**
 * 結果不明の行の文（docs/design-system/writing.md の「結果不明」：分からないこと＋確認する人＋それまで何ができないか。
 * 成功とも失敗とも書かない）。0 件なら空
 */
function unknownText(c: PickCounts, help: string): string {
  return c.unknown
    ? `${formatCount(c.unknown)} 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。${help}`
    : "";
}

/** 結果不明の文の最後に添える、確認を頼む先（管理者でない利用者に出す。管理者には空を渡す） */
export const UNKNOWN_HELP = "管理者に確かめを頼んでください。";

/** 成功の文。管理者が記録した行を含むときは「インポート済みです（うち K 件は管理者が確認）」の型にする */
function okText(c: PickCounts, lead: string): string {
  return c.confirmedOk
    ? `${lead}${formatCount(c.ok)} 件はインポート済みです（うち ${formatCount(c.confirmedOk)} 件は管理者が確認）。`
    : `${lead}${formatCount(c.ok)} 件をインポートしました。`;
}

/** 失敗の文（失敗が 0 件なら空）。管理者が記録した行があれば、理由の前に「うち K 件は管理者が確認」を添える */
function ngText(c: PickCounts): string {
  if (!c.ng) return "";
  const who = c.confirmedNg ? `うち ${formatCount(c.confirmedNg)} 件は管理者が確認。` : "";
  return `${formatCount(c.ng)} 件は失敗しました（${who}理由は各行の状態）。`;
}

/**
 * 終わったときの知らせ（区画の上）。kind は Notice の種類、alert は失敗か結果不明があるとき。
 * 管理者が記録した行を含むときは silent（role を付けない）：記録のときに読み上げの領域が 1 回伝えるので、知らせでは再度読み上げない。
 * 失敗の文は「理由は各行の状態」で止める（理由が「もう画像サーバーにある」のときは、選び直しても入らないため）
 */
export function resultNotice(c: PickCounts, unknownHelp = UNKNOWN_HELP): { kind: "ok" | "warn" | "err"; text: string; alert: boolean; silent?: true } {
  const trouble = c.ng > 0 || c.unknown > 0;
  const silent = c.confirmedOk + c.confirmedNg > 0 ? ({ silent: true } as const) : {};
  if (c.cancelled) {
    return {
      kind: trouble ? "err" : "warn",
      text: `${okText(c, "")}残り ${formatCount(c.cancelled)} 件は中止したためインポートしていません。${ngText(c)}${unknownText(c, unknownHelp)}`,
      alert: trouble,
      ...silent,
    };
  }
  if (trouble || c.confirmedOk) {
    return {
      kind: trouble ? "err" : "ok",
      text: `${okText(c, `選択 ${formatCount(c.selected)} 件のうち `)}${ngText(c)}${unknownText(c, unknownHelp)}`,
      alert: trouble,
      ...silent,
    };
  }
  return { kind: "ok", text: `${formatCount(c.ok)} 件（${formatSize(c.selectedBytes)}）をインポートしました。`, alert: false };
}

/** 中止の確認の窓の本文（済んだ数と残りの数。窓を開いている間は数を動かさない） */
export function abortBody(items: readonly PickItem<unknown>[]): string {
  const c = countItems(items);
  const running = items.filter((i) => isSelected(i) && i.state === "run").length;
  const waiting = items.filter((i) => isSelected(i) && i.state === "wait").length;
  const head = `インポート済みの ${formatCount(c.ok)} 件は保管に残ります。`;
  return running
    ? `${head}実行中の ${formatCount(running)} 件を終えたあと、残りの ${formatCount(waiting)} 件はインポートしません。`
    : `${head}残りの ${formatCount(waiting)} 件はインポートしません。`;
}

/** 中止の後：待っていた行を「中止」にする */
export function cancelWaiting<F>(items: readonly PickItem<F>[]): { items: PickItem<F>[]; cancelled: number } {
  let cancelled = 0;
  const next = items.map((i) => {
    if (isSelected(i) && i.state === "wait") {
      cancelled++;
      return { ...i, state: "cx" as const, reason: "中止したためインポートしていません" };
    }
    return i;
  });
  return { items: next, cancelled };
}

/** 状態の札の種類と語（除外は off で決まる） */
export function badgeOf(i: PickItem<unknown>): { kind: "plan" | "wait" | "ok" | "ng" | "unknown" | "skip" | "stop"; label: string } {
  if (i.off) return { kind: "skip", label: "除外" };
  switch (i.state) {
    case "check":
      return { kind: "wait", label: "確認中" };
    case "wait":
      return { kind: "plan", label: "インポート待ち" };
    case "run":
      return { kind: "wait", label: "インポート中" };
    case "ok":
      return { kind: "ok", label: "成功" };
    case "ng":
      return { kind: "ng", label: "失敗" };
    case "uk":
      return { kind: "unknown", label: "結果不明" };
    case "ex":
      return { kind: "skip", label: "対象外" };
    case "cx":
      return { kind: "stop", label: "中止" };
  }
}

/** シリーズ／画像の列（S2 / I15。片方だけ読めないときは —、両方とも読めなければ空＝「—」） */
export function seriesImageText(tags: PreviewTags | null): string {
  if (!tags || (!tags.seriesNumber && !tags.instanceNumber)) return "";
  return `S${tags.seriesNumber || "—"} / I${tags.instanceNumber || "—"}`;
}

/** 追加したときの読み上げ */
export function addedMessage(fresh: readonly PickItem<unknown>[], duplicates: number, all: readonly PickItem<unknown>[]): string {
  const ex = fresh.filter((i) => i.state === "ex").length;
  const dup = duplicates ? `同じ ${formatCount(duplicates)} 件は追加していません。` : "";
  if (!fresh.length) return dup;
  const total = all.reduce((s, i) => s + i.size, 0);
  return `${formatCount(fresh.length)} 件を追加しました。${ex ? `対象外 ${formatCount(ex)} 件。` : ""}${dup}合計 ${formatCount(all.length)} 件・${formatSize(total)}。`;
}

/** 確認できる行（結果不明で、BFF に届いた要求の識別子を持つ）。「確認」のボタンを出す行 */
export const isResolvable = (i: PickItem<unknown>): i is PickItem<unknown> & { resolve: ResolveTarget } => i.state === "uk" && !i.off && !!i.resolve;

/** 結果不明の理由の句を替える先（確認して記録した行の、札の下の 1 句） */
export const RESOLVED_NOTE = "管理者が確認";

/** 記録を送れなかった（通信が切れた）ときの文。何が起きたか・次にすること（RESOLVE_FAILED_MESSAGE と同じ型） */
export const RESOLVE_UNREACHABLE_MESSAGE = "サーバーに接続できませんでした。時間をおいて、やり直してください";

/** 確認内容の欄の誤り（空・空白だけ） */
export const NOTE_REQUIRED = "確認内容を入力してください。";

/** 確認して記録したあと：その行の札を成功か失敗に替える。識別子は外し、札の下の 1 句は「管理者が確認」にする */
export function resolveItem<F>(items: readonly PickItem<F>[], id: number, outcome: "success" | "failed"): PickItem<F>[] {
  return items.map((i) => {
    if (i.id !== id || !isResolvable(i)) return i;
    const next: PickItem<F> = { ...i, state: outcome === "success" ? "ok" : "ng", reason: RESOLVED_NOTE, confirmed: true };
    delete next.resolve;
    return next;
  });
}

/** 確認して記録したときの読み上げ（結果不明が残るときは、残りの数を添える） */
export function resolvedMessage(name: string, outcome: "success" | "failed", remaining: number): string {
  const head = `${name} を${outcome === "success" ? "成功" : "失敗"}として記録しました。`;
  return remaining ? `${head}結果不明 ${formatCount(remaining)} 件。` : head;
}

/** 次に確認する行（今の行の後ろにある確認できる行を、並びの順で探す。無ければ先頭から。無ければ null） */
export function nextResolvable<T extends PickItem<unknown>>(items: readonly T[], afterId: number): T | null {
  const list = sortForList(items).filter(isResolvable);
  const at = list.findIndex((i) => i.id === afterId);
  return (at >= 0 ? list[at + 1] : undefined) ?? list.find((i) => i.id !== afterId) ?? null;
}
