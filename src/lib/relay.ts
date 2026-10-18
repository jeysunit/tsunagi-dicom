import type { AuditFields } from "@/lib/auth/session";
import { wadoRsTarget } from "@/lib/backend/relay-path";
import { BackendError, type Backend } from "@/lib/backend/types";

// BFF の中継（/api/dicom-web/...）の中身。docs/spec.md の 3.2・原則 8。
// 通すのは、ビューアが画像を取る道（WADO-RS の GET・HEAD の読み取り）だけ。
// - 検索（QIDO-RS）は通さない。検索は画面の API（役割ごとの許可の一覧の対象）を使う。
// - 書き込み（STOW-RS など）の道は段 4 まで作らない。POST・PUT・PATCH・DELETE はいつも 405 で断る。
// - 通したものも断ったものも、監査の記録に残す。通したものは、画像サーバーの答え（状態の番号）が出てから
//   結果つきで記録し、記録に失敗したら応答を渡さない（記録の無い取得を作らない）。

export interface RelayInput {
  method: string;
  /** Next.js が分けた path の段（`/api/dicom-web` より後ろ） */
  segments: string[];
  search: string;
  accept: string | null;
}

export interface RelayDeps {
  backend: Pick<Backend, "relayDicomweb">;
  /** いまの利用者で監査の記録に1行足す */
  record: (fields: AuditFields) => Promise<unknown>;
}

export const RELAY_READ_ONLY_MESSAGE = "中継は WADO-RS の読み取り（GET）だけ。書き込みの道は段 4 まで無い";
export const RELAY_NOT_WADO_MESSAGE = "中継は WADO-RS の読み取りだけ。検索は画面の API を使う";

/** 記録に残す path（要求のままの値なので、長さを切る） */
const pathForAudit = (segments: string[]) => segments.join("/").slice(0, 512);

export async function relayWadoRs(input: RelayInput, deps: RelayDeps): Promise<Response> {
  const method = input.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    await deps.record({
      action: "write",
      outcome: "denied",
      detail: { method, path: pathForAudit(input.segments), reason: "relay-read-only" },
    });
    return Response.json({ error: RELAY_READ_ONLY_MESSAGE }, { status: 405, headers: { allow: "GET, HEAD" } });
  }

  // 字が使えない path は 400（BackendError を投げる）
  const target = wadoRsTarget(input.segments);
  if (!target) {
    await deps.record({
      action: "retrieve",
      outcome: "denied",
      detail: { method, path: pathForAudit(input.segments), reason: "not-wado-rs" },
    });
    return Response.json({ error: RELAY_NOT_WADO_MESSAGE }, { status: 404 });
  }

  const where = {
    studyInstanceUid: target.studyInstanceUid,
    detail: {
      method,
      path: target.path,
      ...(target.seriesInstanceUid ? { seriesInstanceUid: target.seriesInstanceUid } : {}),
      ...(target.sopInstanceUid ? { sopInstanceUid: target.sopInstanceUid } : {}),
    },
  };

  let res: Response;
  try {
    res = await deps.backend.relayDicomweb({ method, target, search: input.search, accept: input.accept });
  } catch (error) {
    const status = error instanceof BackendError ? error.status : 500;
    await deps.record({ action: "retrieve", outcome: "failed", ...where, detail: { ...where.detail, status } });
    throw error;
  }

  try {
    await deps.record({
      action: "retrieve",
      outcome: res.ok ? "success" : "failed",
      ...where,
      detail: { ...where.detail, status: res.status },
    });
  } catch (error) {
    await res.body?.cancel();
    throw error;
  }
  return res;
}
