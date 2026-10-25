import type { Backend } from "@/lib/backend/types";
import type { Db } from "@/lib/db";
import type { FieldAllowlist } from "@/lib/fields";

// 上の帯の「接続の状態」の材料（docs/spec.md の 3.3）。読むだけで、相手に何も送らない。
// - 画像サーバー（Orthanc）：機器の一覧（/modalities）を読めたか。読めなければ「失敗」
// - HL7 の受け口：HL7_RECEIVER_TOKEN_FILE を渡してあれば「待ち受け中」（受け口はこのアプリの中の道なので、このアプリが答えていれば待っている）
// - 接続先：直近の接続確認（監査の記録の echo）の結果。確かめていない接続先は札を出さない
// 返す項目は許可の一覧の connection（src/lib/fields.ts）で絞る。

export type ConnectionResult = "ok" | "ng";

export interface ConnectionTarget {
  id: string;
  aet: string;
  /** 直近の接続確認の結果（まだ確かめていなければ null） */
  result: ConnectionResult | null;
  /** 直近の接続確認の時刻（ISO 8601。null は未確認） */
  at: string | null;
}

export interface ConnectionRecord {
  /** 全体の状態：画像サーバーが読めない、または直近の接続確認が失敗した接続先があれば ng */
  overall: ConnectionResult;
  orthanc: ConnectionResult;
  hl7: "listen" | "off";
  modalities: ConnectionTarget[];
  /** モックのバックエンド（BACKEND_MOCK=true）につないでいる */
  mock: boolean;
}
/** 画面の API が返す形（許可の一覧に載った項目だけ） */
export type ConnectionView = Partial<Omit<ConnectionRecord, "modalities">> & {
  modalities?: (Omit<ConnectionTarget, "aet"> & { aet?: string })[];
};

/** 1 つの接続先を探すとき、新しい順に読む行の数の上限（同じ名前を含む別の行を読み飛ばすため。名前は引用符で閉じて探すので、ふつうは 1 行で見つかる） */
const ECHO_LOOKBACK_ROWS = 20;

/**
 * 監査の記録から、登録された接続先ごとに直近の接続確認（echo）の結果を読む。断った要求（denied）は確かめていないので数えない。
 * 接続先ごとに探すので、ほかの接続先の確認がどれだけ続いても、その接続先の直近の結果は消えない
 */
export async function lastEchoResults(db: Pick<Db, "auditLog">, ids: readonly string[]): Promise<Map<string, { result: ConnectionResult; at: Date }>> {
  const latest = new Map<string, { result: ConnectionResult; at: Date }>();
  await Promise.all(
    ids.map(async (id) => {
      const rows = await db.auditLog.findMany({
        where: { action: "echo", outcome: { in: ["success", "failed"] }, detail: { contains: `"modality":${JSON.stringify(id)}` } },
        orderBy: { seq: "desc" },
        take: ECHO_LOOKBACK_ROWS,
        select: { occurredAt: true, outcome: true, detail: true },
      });
      for (const row of rows) {
        let detail: Record<string, unknown>;
        try {
          detail = JSON.parse(row.detail ?? "{}") as Record<string, unknown>;
        } catch {
          continue;
        }
        if (detail.modality !== id) continue;
        // connected が付くのは Orthanc の答えを読めたとき。付かない failed は、確かめそのものが失敗した（失敗として数える）
        latest.set(id, { result: row.outcome === "success" && detail.connected === true ? "ok" : "ng", at: row.occurredAt });
        return;
      }
    }),
  );
  return latest;
}

export async function connectionRecord(deps: {
  backend: Pick<Backend, "listModalities" | "mock">;
  db: Pick<Db, "auditLog">;
  hl7Configured: boolean;
}): Promise<ConnectionRecord> {
  let orthanc: ConnectionResult = "ok";
  let entries: Awaited<ReturnType<Backend["listModalities"]>> = [];
  try {
    entries = await deps.backend.listModalities();
  } catch {
    orthanc = "ng";
  }
  const echoes = await lastEchoResults(
    deps.db,
    entries.map((m) => m.id),
  );
  const modalities = entries.map((m): ConnectionTarget => {
    const last = echoes.get(m.id);
    return { id: m.id, aet: m.aet, result: last?.result ?? null, at: last ? last.at.toISOString() : null };
  });
  return {
    overall: orthanc === "ng" || modalities.some((m) => m.result === "ng") ? "ng" : "ok",
    orthanc,
    hl7: deps.hl7Configured ? "listen" : "off",
    modalities,
    mock: deps.backend.mock,
  };
}

/** 接続の状態を、役割の許可の一覧で絞る。接続先の名前と AE タイトルは、機器の一覧と同じく modality の許可の一覧で絞る */
export function connectionView(record: ConnectionRecord, allowlist: FieldAllowlist): ConnectionView {
  const allowed = new Set<string>(allowlist.connection ?? []);
  const view: ConnectionView = {};
  if (allowed.has("overall")) view.overall = record.overall;
  if (allowed.has("orthanc")) view.orthanc = record.orthanc;
  if (allowed.has("hl7")) view.hl7 = record.hl7;
  if (allowed.has("mock")) view.mock = record.mock;
  // 接続先は名前（id）を見せてよい役割にだけ返す。AE タイトルも、見せてよい役割にだけ付ける
  const modality = new Set<string>(allowlist.modality ?? []);
  if (allowed.has("modalities") && modality.has("id")) {
    view.modalities = record.modalities.map((m) => ({
      id: m.id,
      ...(modality.has("aet") ? { aet: m.aet } : {}),
      result: m.result,
      at: m.at,
    }));
  }
  return view;
}
