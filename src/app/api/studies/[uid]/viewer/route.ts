import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { audit } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db";
import { rememberViewer } from "@/lib/study-state";
import { availableViewers, VIEWER_IDS } from "@/lib/viewers";

// 検査ごとに既定のビューアを覚える（「この検査は次から VolView」。docs/spec.md の 3.2）。null で忘れる。
// 覚えはほかの利用者にも効くので、操作の権限（viewer.remember）を要る。変えたことを監査の記録に残す。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({ viewer: z.enum(VIEWER_IDS).nullable() });

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request, "viewer.remember");
    const uid = studyUidParam((await params).uid);
    const { viewer } = await readJson(request, Body, 256);
    if (viewer && !availableViewers(getConfig().viewers).some((v) => v.id === viewer && v.kind === "open")) {
      return Response.json({ error: "このビューアは設定されていない" }, { status: 400 });
    }
    await rememberViewer(await getDb(), session.actorId, uid, viewer);
    await audit(session, { action: "study_state", studyInstanceUid: uid, detail: { flag: "viewer", value: viewer } });
    return Response.json({ viewer });
  } catch (error) {
    return errorResponse(error);
  }
}
