import "server-only";
import type { Session } from "@/lib/auth/session";

// 検査一覧の自動更新の読み直しの「名乗り」（`?refresh=auto`）の扱い（docs/spec.md の 3.6 の監査の記録）。
// 名乗りはブラウザが付ける値なので、利用者が自分の検索を「自動」と名乗れる。名乗りで監査が薄まらないよう、
// - 監査の行は、自動でも手動でも同じに残す（権限の確かめ・残す項目・保存の扱いは変えない）。
// - detail の trigger: "auto" は「申告された値」として残すだけ。
// - 自動と認めるのは、同じセッションの直前の手動の検索と同じ条件の読み直しだけ。条件が違えば手動として扱う。
// 直前の手動の検索の条件は、このプロセスの記憶の中に持つ（BFF のデータベースに写さない）。プロセスが起き直した後の
// 最初の名乗りは、手動として扱う（監査を薄めない側）。

/** 覚えるセッションの数の上限（古いものから忘れる） */
const MAX_SESSIONS = 1000;

const KEY = Symbol.for("tsunagi-dicom.last-manual-search");
const holder = globalThis as typeof globalThis & { [KEY]?: Map<string, string> };
const lastManual = (holder[KEY] ??= new Map<string, string>());

/** セッションを見分ける鍵（ローカルの認証はセッションの行、検証モードは利用者） */
function sessionKey(session: Session): string {
  return session.local?.row.id ? `local:${session.local.row.id}` : `${session.authMode}:${session.actorId}`;
}

function remember(key: string, condition: string): void {
  lastManual.delete(key);
  lastManual.set(key, condition);
  if (lastManual.size > MAX_SESSIONS) {
    const oldest = lastManual.keys().next().value;
    if (oldest !== undefined) lastManual.delete(oldest);
  }
}

/**
 * 検索の記録の trigger を決める。`claimed` が auto で、条件（並べ直した絞り込みの URL の形）が同じセッションの
 * 直前の手動の検索と同じときだけ "auto"。そのほかは手動として扱い、この検索の条件を「直前の手動の検索」として覚える
 */
export function resolveSearchTrigger(session: Session, condition: string, claimed: string | null): "auto" | undefined {
  const key = sessionKey(session);
  if (claimed === "auto" && lastManual.get(key) === condition) return "auto";
  remember(key, condition);
  return undefined;
}

/** 試験のため：覚えた条件を忘れる */
export function forgetManualSearches(): void {
  lastManual.clear();
}
