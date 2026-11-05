import type { ImportOutcome } from "@/components/ui/file-picker";

// インポートの画面（docs/spec.md の 3.5「取り込み」。段 6）が、選んだファイルを 1 件ずつ BFF へ送る。
// 本文はファイルのバイトのまま（POST /api/import）。要求の ID は x-request-id、まとめて選んだ組は x-import-batch・
// x-import-index（1 から）・x-import-total。答えが分からなければ、同じ要求の ID で状態を 1 回確かめる（GET ?requestId=…）。
// 結果は、ファイルを選ぶ部品の 1 件の結果（成功・失敗・結果不明）に写す。BFF の誤りの文は、最初の 1 文を理由の 1 句にする。

/** 組（まとめて選んだファイル）。index は 1 から */
export interface ImportBatch {
  id: string;
  index: number;
  total: number;
}

interface Answer {
  status: number;
  data: { outcome?: unknown; error?: unknown };
}

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
 * BFF の答えを 1 件の結果に写す。outcome が unknown なら（202・502 のどちらでも）結果不明、stored は成功、
 * already（Orthanc がもう持っていた）は成功と 1 句、ほかは失敗。null は状態の確かめが要る（答えが分からない）
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
 * 状態の確かめ（GET）の答えを結果に写す。stored は成功、failed は失敗、none（BFF に記録が無い）は、送った要求が
 * BFF に届かなかったときだけ失敗（届いたか分からないときは結果不明のまま）。ほかは結果不明（理由は確かめの答えの文、
 * 無ければ最初の答えの文）
 */
export function checkedOutcomeOf(answer: Answer | null, sent: "reached" | "unreachable", firstError?: unknown): ImportOutcome {
  const unknown = (error?: unknown): ImportOutcome => ({
    ok: false,
    unknown: true,
    reason: reasonOf(error, reasonOf(firstError, UNKNOWN_REASON)),
  });
  if (!answer || answer.status < 200 || answer.status >= 300) return sent === "unreachable" ? { ok: false, reason: UNREACHABLE_REASON } : unknown();
  const { outcome, error } = answer.data;
  if (outcome === "stored") return { ok: true };
  if (outcome === "failed") return { ok: false, reason: reasonOf(error, FAILED_REASON) };
  if (outcome === "none") return sent === "unreachable" ? { ok: false, reason: UNREACHABLE_REASON } : unknown();
  return unknown(error);
}

async function read(res: Response): Promise<Answer> {
  const data = (await res.json().catch(() => ({}))) as Answer["data"];
  return { status: res.status, data: data && typeof data === "object" ? data : {} };
}

/** 1 件を送る。答えが分からなければ、同じ要求の ID で状態を 1 回確かめる */
export async function importFile(
  file: Blob,
  batch: ImportBatch,
  csrfToken: string | undefined,
  fetcher: typeof fetch = fetch,
  newId: () => string = () => crypto.randomUUID(),
): Promise<ImportOutcome> {
  const requestId = newId();
  let sent: "reached" | "unreachable" = "reached";
  let firstError: unknown;
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
    const answer = await read(res);
    const outcome = outcomeOf(answer);
    if (outcome) return outcome;
    firstError = answer.data.error;
  } catch {
    // 送っている間に切れた：BFF に届いたかが分からない。記録が無ければ届かなかったとして失敗にする
    sent = "unreachable";
  }
  try {
    const res = await fetcher(`/api/import?${new URLSearchParams({ requestId })}`, { credentials: "same-origin" });
    return checkedOutcomeOf(await read(res), sent, firstError);
  } catch {
    return checkedOutcomeOf(null, sent, firstError);
  }
}
