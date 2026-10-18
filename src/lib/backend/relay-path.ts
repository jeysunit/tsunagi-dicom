import { BackendError } from "@/lib/backend/types";

// 中継の path を確かめる。`..`・空の段・制御文字を断り、各段を URL の形に符号化する。
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function safeRelayPath(segments: string[]): string {
  if (segments.length === 0) throw new BackendError("path が空", 400);
  for (const s of segments) {
    if (s === "." || s === ".." || !SEGMENT.test(s)) throw new BackendError("path に使えない字がある", 400);
  }
  return segments.map(encodeURIComponent).join("/");
}
