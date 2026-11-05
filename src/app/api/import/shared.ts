import type { RequestRow } from "@/lib/pacs-ops";

// インポートの記録の行を読む部品（POST・GET の /api/import と、管理者が手で解く /api/studies/{uid}/import/resolve で使う）。

/** 記録の detail（JSON）を読む。読めなければ空 */
export function parse(detail: string | null): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(detail ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 「求めた」の行に残したファイル（SOP Instance UID・SHA-256・患者 ID・組）。無ければ null */
export function requestFile(
  rows: readonly (RequestRow & { patientId?: string | null })[],
): { sopInstanceUid: string; sha256: string; patientId: string; batch?: unknown } | null {
  for (const row of rows) {
    const d = parse(row.detail);
    if (d.phase === "request" && typeof d.sopInstanceUid === "string" && typeof d.sha256 === "string") {
      return { sopInstanceUid: d.sopInstanceUid, sha256: d.sha256, patientId: row.patientId ?? "", ...(d.batch ? { batch: d.batch } : {}) };
    }
  }
  return null;
}

/** 「消す」の行（cleanup_request）に残した、このインポートで入れた画像の Orthanc の ID。無ければ null */
export function cleanupTarget(rows: readonly RequestRow[]): string | null {
  for (const row of rows) {
    const d = parse(row.detail);
    if (d.phase === "cleanup_request" && typeof d.orthancInstanceId === "string") return d.orthancInstanceId;
  }
  return null;
}
