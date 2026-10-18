import type { AppConfig } from "@/lib/config";

// 書き込み（修正・削除・取り込み・ワークリストの作成）を通してよいか（docs/spec.md の 4）。
// AUTH_MODE=dev では既定で止め、DEV_ALLOW_WRITE=true のときだけ通す。

export type WriteDecision = { allowed: true } | { allowed: false; reason: string };

export const DEV_WRITE_BLOCKED_MESSAGE =
  "検証モード（AUTH_MODE=dev）では書き込みを止めている。試すときは DEV_ALLOW_WRITE=true を足す";

export function decideWrite(auth: Pick<AppConfig["auth"], "mode" | "devAllowWrite">): WriteDecision {
  if (auth.mode === "dev" && !auth.devAllowWrite) {
    return { allowed: false, reason: DEV_WRITE_BLOCKED_MESSAGE };
  }
  return { allowed: true };
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** HTTP の method が書き込みにあたるか */
export function isWriteMethod(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}
