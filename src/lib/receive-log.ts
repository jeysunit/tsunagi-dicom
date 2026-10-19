import type { Role } from "@/lib/auth/roles";
import type { Backend, StudySummary } from "@/lib/backend/types";
import { allowlistFor, receivedView, studyRecord, type FieldAllowlistMap, type ReceivedView } from "@/lib/fields";

// 受け取りの記録の画面の API と頁で同じものを使う（docs/spec.md の 3.3）。

/** 一度に返す受け取りの記録の数（docs/spec.md の 3.3） */
export const RECEIVE_LIMIT = 100;

export async function receiveLogView(
  backend: Pick<Backend, "receivedStudies">,
  role: Role,
  allowlists?: FieldAllowlistMap,
): Promise<{ items: ReceivedView[]; returned: StudySummary[] }> {
  const allowlist = allowlistFor(role, allowlists);
  const received = await backend.receivedStudies(RECEIVE_LIMIT);
  return {
    items: received.map((r) =>
      receivedView(
        { receivedAt: r.receivedAt, remoteAet: r.remoteAet, origin: r.origin, receivedInstances: r.instanceCount },
        studyRecord(r.summary),
        allowlist,
      ),
    ),
    returned: received.map((r) => r.summary),
  };
}
