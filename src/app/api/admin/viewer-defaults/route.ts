import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { audit, requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { MODALITY_GROUPS } from "@/lib/modalities";
import { modalityDefaults, setModalityDefault } from "@/lib/study-state";
import { VIEWER_IDS } from "@/lib/viewers";

// モダリティごとの既定のビューア（docs/spec.md の 3.2「選び方の3段」の3）。管理の画面で変える（viewer.defaults）。
// 変えたことを設定の変更として監査の記録に残す。

export async function GET() {
  try {
    await requireSession("viewer.defaults");
    return Response.json({ defaults: await modalityDefaults(await getDb()) });
  } catch (error) {
    return errorResponse(error);
  }
}

const Body = z.object({ modality: z.enum(MODALITY_GROUPS), viewer: z.enum(VIEWER_IDS).exclude(["dicomweb"]) });

export async function POST(request: Request) {
  try {
    const session = await checkedScreenWrite(request, "viewer.defaults");
    const { modality, viewer } = await readJson(request, Body, 256);
    const db = await getDb();
    const before = (await modalityDefaults(db))[modality];
    await setModalityDefault(db, session.actorId, modality, viewer);
    await audit(session, { action: "config_change", detail: { setting: "modality_viewer_default", modality, from: before, to: viewer } });
    return Response.json({ modality, viewer });
  } catch (error) {
    return errorResponse(error);
  }
}
