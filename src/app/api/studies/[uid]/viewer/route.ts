import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { auditWith, requirePermission } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { rememberViewer } from "@/lib/viewer-memory";
import { availableViewers, VIEWER_IDS } from "@/lib/viewers";

// 検査ごとに既定のビューアを覚える（「この検査は次から VolView」。docs/spec.md の 3.2）。null で忘れる。
// 覚えはほかの利用者にも効くので、操作の権限（viewer.remember）を要る（無ければ断ったことを記録して 403）。
// 変更と監査の記録は1つの transaction。版はビューアの覚えの行のもので、違えば書かずに 409。
// 監査の記録の action は、段 2 からの study_state（detail の flag は viewer）のまま（記録済みの行と同じ形で追えるように）。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({
  viewer: z.enum(VIEWER_IDS).nullable(),
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { viewer, version } = await readJson(request, Body, 256);
    await requirePermission(session, "viewer.remember", {
      action: "study_state",
      studyInstanceUid: uid,
      detail: { flag: "viewer", value: viewer },
    });
    if (viewer && !availableViewers(getConfig().viewers).some((v) => v.id === viewer && v.kind === "open")) {
      return Response.json({ error: "このビューアは設定されていない" }, { status: 400 });
    }
    const result = await auditWith(session, async (tx) => {
      const r = await rememberViewer(tx, session.actorId, uid, viewer, version);
      return {
        value: r,
        fields: {
          action: "study_state",
          outcome: r.kind === "ok" ? "success" : "denied",
          studyInstanceUid: uid,
          detail: {
            flag: "viewer",
            value: viewer,
            ...(r.kind === "conflict" ? { reason: "conflict", expected: version, current: r.version } : {}),
          },
        },
      };
    });
    if (result.kind === "conflict") {
      return Response.json({ error: "ほかの利用者が先に変えた。読み直した値を確かめる", version: result.version }, { status: 409 });
    }
    return Response.json({ viewer, version: result.version });
  } catch (error) {
    return errorResponse(error);
  }
}
