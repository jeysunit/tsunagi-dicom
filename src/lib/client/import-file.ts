import type { ImportOutcome, ResolveResult } from "@/components/ui/file-picker";
import { handleAuthStatus } from "@/lib/client/api";
import { RESOLVE_UNREACHABLE_MESSAGE, type ResolveTarget } from "@/lib/import/picker-model";

// インポートの画面（docs/spec.md の 3.5「取り込み」。フェーズ 6）が、選んだファイルを 1 件ずつ BFF へ送る。
// 本文はファイルのバイトのまま（POST /api/import）。要求の ID は x-request-id、まとめて選んだ組は x-import-batch・
// x-import-index（1 から）・x-import-total。答えが分からなければ、同じ要求の ID で状態を 1 回確認する（GET ?requestId=…）。
// 結果は、ファイルを選ぶ部品の 1 件の結果（成功・失敗・結果不明）にコピーする。BFF の誤りの文は、最初の 1 文を理由の 1 句にする。

/** 組（まとめて選んだファイル）。index は 1 から */
export interface ImportBatch {
  id: string;
  index: number;
  total: number;
}

interface Answer {
  status: number;
  data: { outcome?: unknown; error?: unknown; studyInstanceUid?: unknown };
}

/** 答えにある検査の UID（BFF が記録に残した要求だけが返す）。無ければ空 */
const studyUidOf = (answer: Answer | null): string => (typeof answer?.data.studyInstanceUid === "string" ? answer.data.studyInstanceUid : "");

/** 画像サーバーにもうあった画像（Orthanc の AlreadyStored）の、成功の札の下の 1 句 */
export const ALREADY_NOTE = "もう画像サーバーにありました";
/** 答えが分からないときの理由の 1 句 */
export const UNKNOWN_REASON = "画像サーバーに入ったか分かりません";
/** BFF に届かなかったときの理由の 1 句 */
export const UNREACHABLE_REASON = "サーバーに接続できませんでした";
const FAILED_REASON = "インポートできませんでした";

/** BFF の誤りの文の最初の 1 文（理由の 1 句。札の下の狭い場所に出す）。無ければ代わりの句 */
export function reasonOf(error: unknown, fallback: string): string {
  if (typeof error !== "string") return fallback;
  const first = error.split("。")[0]!.trim();
  return first || fallback;
}

/**
 * BFF の答えを 1 件の結果にコピーする。outcome が unknown なら（202・502 のどちらでも）結果不明、stored は成功、
 * already（Orthanc がもう持っていた）は成功と 1 句、ほかは失敗。null は状態の確認が要る（答えが分からない）
 */
export function outcomeOf(answer: Answer): ImportOutcome | null {
  const { outcome, error } = answer.data;
  if (outcome === "unknown") return null;
  if (answer.status >= 200 && answer.status < 300) {
    if (outcome === "stored") return { ok: true };
    if (outcome === "already") return { ok: true, note: ALREADY_NOTE };
  }
  return { ok: false, reason: reasonOf(error, FAILED_REASON) };
}

/**
 * 状態の確認（GET）の答えを結果にコピーする。stored は成功、failed は失敗、none（BFF に記録が無い）は、送った要求が
 * BFF に届かなかったときだけ失敗（届いたか分からないときは結果不明のまま）。ほかは結果不明。
 * 結果不明の理由は、いつも同じ 1 句にする（行ごとに語を変えない。BFF の文は記録と状態の確認の側に残る）
 */
export function checkedOutcomeOf(answer: Answer | null, sent: "reached" | "unreachable", target?: ResolveTarget): ImportOutcome {
  // 結果不明の行は、BFF に届いた要求（検査の UID が分かる）だけ、管理者が確認して記録するための識別子を持つ
  const unknown: ImportOutcome = { ok: false, unknown: true, reason: UNKNOWN_REASON, ...(target ? { resolve: target } : {}) };
  // 確認も読めない：送った要求が届いたかも分からないので、通信が切れたときも結果不明にする（失敗と言い切らない）
  if (!answer || answer.status < 200 || answer.status >= 300) return unknown;
  // 記録が無い（none）：送っている間に切れたときだけ失敗にする。BFF は送り直された同じ画像を断るので、選び直して
  // 入れ直しても中身は置き換わらない（記録の前にまだ本文を読んでいる要求と行き違うことは残る。docs/spec.md の 3.5）
  const { outcome, error } = answer.data;
  if (outcome === "stored") return { ok: true };
  if (outcome === "failed") return { ok: false, reason: reasonOf(error, FAILED_REASON) };
  if (outcome === "none") return sent === "unreachable" ? { ok: false, reason: UNREACHABLE_REASON } : unknown;
  return unknown;
}

/** ログインが切れた（401）・画面がロックされた（423）。ログインの頁へ移す・再読み込みしてロックの画面にする */
const AUTH_STATUSES = new Set([401, 423]);

/** 答えを読む。本文を読み切れない（途中で切れた・JSON でない）ときは null（答えが分からない） */
async function read(res: Response): Promise<Answer | null> {
  try {
    const data: unknown = await res.json();
    return { status: res.status, data: data && typeof data === "object" ? (data as Answer["data"]) : {} };
  } catch {
    return null;
  }
}

/**
 * 1 件を送る。答えが分からなければ、同じ要求の ID で状態を 1 回確認する。ログインが切れた・画面がロックされたときは
 * onAuth（初期値は検査一覧などと同じ扱い：401 はログインの頁へ、423 は再読み込み）を呼ぶ。頁を離れると、部品は残りを送らない
 */
export async function importFile(
  file: Blob,
  batch: ImportBatch,
  csrfToken: string | undefined,
  fetcher: typeof fetch = fetch,
  newId: () => string = () => crypto.randomUUID(),
  onAuth: (status: number) => void = handleAuthStatus,
): Promise<ImportOutcome> {
  const requestId = newId();
  let sent: "reached" | "unreachable" = "reached";
  // 送った答えにあった検査の UID（状態の確認の答えに無いときの代わり）
  let postedUid = "";
  try {
    const res = await fetcher("/api/import", {
      method: "POST",
      headers: {
        "content-type": "application/dicom",
        "x-request-id": requestId,
        "x-import-batch": batch.id,
        "x-import-index": String(batch.index),
        "x-import-total": String(batch.total),
        ...(csrfToken ? { "x-csrf-token": csrfToken } : {}),
      },
      body: file,
      credentials: "same-origin",
    });
    // 頭が届いても本文を読み切れなければ、画像サーバーに入ったかが分からない。失敗と決めずに状態を確認する
    if (AUTH_STATUSES.has(res.status)) onAuth(res.status);
    const answer = await read(res);
    postedUid = studyUidOf(answer);
    const outcome = answer ? outcomeOf(answer) : null;
    if (outcome) return outcome;
  } catch {
    // 送っている間に切れた：BFF に届いたかが分からない。記録が無ければ届かなかったとして失敗にする
    sent = "unreachable";
  }
  try {
    const res = await fetcher(`/api/import?${new URLSearchParams({ requestId })}`, { credentials: "same-origin" });
    if (AUTH_STATUSES.has(res.status)) onAuth(res.status);
    const checked = await read(res);
    const uid = studyUidOf(checked) || postedUid;
    return checkedOutcomeOf(checked, sent, uid ? { requestId, studyInstanceUid: uid } : undefined);
  } catch {
    return checkedOutcomeOf(null, sent, postedUid ? { requestId, studyInstanceUid: postedUid } : undefined);
  }
}

/** 記録できなかったが BFF の文が無いときの文（何が起きたか・次にすること） */
export const RESOLVE_FAILED_MESSAGE = "記録できませんでした。時間をおいて、やり直してください";

/**
 * 結果不明の行を、管理者が確認して成功か失敗として記録する（POST /api/studies/{uid}/import/resolve。BFF は画像サーバーを再取得し、
 * 成功は画像があるときだけ記録する）。記録できなかったときは BFF の誤りの文（何が起きたか・なぜか・次にすること）を返す。
 * ログインが切れた（401）・画面がロックされた（423）ときは onAuth を呼ぶ
 */
export async function resolveImport(
  target: ResolveTarget,
  outcome: "success" | "failed",
  note: string,
  csrfToken: string | undefined,
  fetcher: typeof fetch = fetch,
  onAuth: (status: number) => void = handleAuthStatus,
): Promise<ResolveResult> {
  try {
    const res = await fetcher(`/api/studies/${encodeURIComponent(target.studyInstanceUid)}/import/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
      body: JSON.stringify({ requestId: target.requestId, outcome, note }),
      credentials: "same-origin",
    });
    if (AUTH_STATUSES.has(res.status)) onAuth(res.status);
    if (res.ok) return { ok: true };
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return { ok: false, message: typeof body.error === "string" && body.error ? body.error : RESOLVE_FAILED_MESSAGE };
  } catch {
    return { ok: false, message: RESOLVE_UNREACHABLE_MESSAGE };
  }
}
