import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ITEST } from "./env";

// 試験の BFF のデータベース（.e2e/itest/itest.db。試験のたびに作り直す）の監査の記録を、読むだけで開く。
// /api/audit/verify はつなぎが壊れていないことしか言わないので、操作ごとに「求めた」「結果」「終わり」の行があるかをここで照らす。

export interface AuditRow {
  seq: number;
  action: string;
  outcome: string;
  studyInstanceUid: string | null;
  detail: Record<string, unknown>;
}

export function readAudit(): AuditRow[] {
  const db = new DatabaseSync(path.join(ITEST.workDir, "itest.db"), { readOnly: true });
  try {
    const rows = db
      .prepare('SELECT seq, action, outcome, studyInstanceUid, detail FROM "AuditLog" ORDER BY seq')
      .all() as { seq: number; action: string; outcome: string; studyInstanceUid: string | null; detail: string | null }[];
    return rows.map((r) => {
      let detail: Record<string, unknown> = {};
      try {
        const v: unknown = r.detail ? JSON.parse(r.detail) : {};
        if (v && typeof v === "object") detail = v as Record<string, unknown>;
      } catch {
        // 読めない detail は空として扱う（照らす側で行が足りなくなる）
      }
      return { seq: r.seq, action: r.action, outcome: r.outcome, studyInstanceUid: r.studyInstanceUid, detail };
    });
  } finally {
    db.close();
  }
}

/** 操作と検査の行を、要求の ID ごとに「phase:outcome」の並び（古い順）にまとめる。要求の ID の無い行（断った行など）は除く */
export function requestTrails(rows: readonly AuditRow[], action: string, studyInstanceUid: string): Map<string, string[]> {
  const trails = new Map<string, string[]>();
  for (const r of rows) {
    if (r.action !== action || r.studyInstanceUid !== studyInstanceUid) continue;
    const id = r.detail.requestId;
    const phase = r.detail.phase;
    if (typeof id !== "string" || typeof phase !== "string") continue;
    trails.set(id, [...(trails.get(id) ?? []), `${phase}:${r.outcome}`]);
  }
  return trails;
}
