import type { Role } from "@/lib/auth/roles";
import type { Backend, StudySummary } from "@/lib/backend/types";
import { allowlistFor, receivedView, studyRecord, type FieldAllowlistMap, type ReceivedView } from "@/lib/fields";
import type { ReceivePeriod } from "@/lib/receive-period";

// 受け取りの記録の画面の API と頁で同じものを使う（docs/spec.md の 3.3）。

/** 期間の中で返す受け取りの記録の数の上限（docs/spec.md の 3.3。超えたら新しい順にこの数だけを返し、画面に知らせる） */
export const RECEIVE_LIMIT = 1000;

export interface ReceiveLog {
  items: ReceivedView[];
  returned: StudySummary[];
  /** 期間の中に RECEIVE_LIMIT 件より多くあった */
  overLimit: boolean;
  /** 期間の始まりまで遡れた（false なら、期間の古い側を読めていない） */
  complete: boolean;
}

export async function receiveLogView(
  backend: Pick<Backend, "receivedStudies">,
  role: Role,
  period: Pick<ReceivePeriod, "fromMs" | "toMs">,
  allowlists?: FieldAllowlistMap,
): Promise<ReceiveLog> {
  const allowlist = allowlistFor(role, allowlists);
  const { studies, overLimit, complete } = await backend.receivedStudies({ fromMs: period.fromMs, toMs: period.toMs, limit: RECEIVE_LIMIT });
  return {
    items: studies.map((r) =>
      receivedView(
        {
          receivedAt: r.receivedAt,
          remoteAet: r.remoteAet,
          origin: r.origin,
          receivedInstances: r.instanceCount,
          receiveState: r.stable === null ? null : r.stable ? "received" : "receiving",
        },
        studyRecord(r.summary),
        allowlist,
      ),
    ),
    returned: studies.map((r) => r.summary),
    overLimit,
    complete,
  };
}
