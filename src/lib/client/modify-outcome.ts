import { errorText, type PostResult } from "@/lib/client/post-json";

// 値の修正の要求への答え（POST）と状態の確認（GET）を、画面の次の状態に読み替える。
// 「結果不明」にしてよいのは、Orthanc を呼んだかもしれないときだけ。呼ぶ前に断った答え
// （503 の QueueFull「処理が混み合っています」など、outcome の無い答え）は、やり直せる誤りとして出す。

export type ModifyDecision =
  | { kind: "reauth" }
  | { kind: "done"; text: string }
  | { kind: "unknown"; partial: boolean; note?: string }
  | { kind: "error"; text: string; /** 確認の画面を閉じて、入力からやり直させる */ restart: boolean };

/** 修正の要求（POST）の答え */
export function decideModify(result: PostResult): ModifyDecision {
  if (result.status === 403 && result.data.problems?.includes("reauth_required")) return { kind: "reauth" };
  const outcome = result.data.outcome;
  if (outcome === "modified") return { kind: "done", text: `修正しました（${Number(result.data.total ?? 1)} 件の検査）` };
  if (outcome === "created") return { kind: "done", text: "修正しました。修正した検査を新しく作りました（元の検査は残っています）" };
  // 503 で outcome が無いのは、列が一杯で、Orthanc を呼ぶ前に断った答え（結果不明ではない）
  const refusedBeforeCall = result.status === 503 && outcome === undefined;
  if (outcome === "partial" || outcome === "unknown" || result.status === 0 || result.status === 202 || (result.status >= 500 && !refusedBeforeCall && outcome !== "failed")) {
    return { kind: "unknown", partial: outcome === "partial", note: typeof result.data.error === "string" ? result.data.error : undefined };
  }
  // 409（確認の後に検査が変わった・結果不明の書き換えがある）は、確認からやり直す
  return { kind: "error", text: errorText(result), restart: result.status === 409 };
}

/** 状態の確認（GET）の答えの本文 */
export interface StatusBody {
  outcome?: string;
  error?: string;
  unresolvedWriteIds?: string[];
}

/** 状態の確認（GET）の答え。none は、その要求の記録が無い（Orthanc を呼んでいない）こと */
export function decideStatus(body: StatusBody): ModifyDecision {
  if (body.outcome === "modified" || body.outcome === "created") return { kind: "done", text: "修正しました" };
  if (body.outcome === "failed") return { kind: "error", text: "修正されていません", restart: false };
  if (body.outcome === "none") return { kind: "error", text: "修正されていません", restart: true };
  return { kind: "unknown", partial: body.outcome === "partial", note: body.error };
}
