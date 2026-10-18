import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { auditWith, requirePermission, requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { MODALITY_GROUPS } from "@/lib/modalities";
import { modalityDefaults, setModalityDefault } from "@/lib/study-state";
import { VIEWER_IDS } from "@/lib/viewers";

// モダリティごとの既定のビューア（docs/spec.md の 3.2「選び方の3段」の3）。管理の画面で変える（viewer.defaults）。
// 変更と、設定の変更としての監査の記録を1つの transaction で書く。権限の無い役割は、断ったことを記録して 403。

const SETTING = "modality_viewer_default";

export async function GET() {
  try {
    const session = await requireSession();
    await requirePermission(session, "viewer.defaults", { action: "config_change", detail: { setting: SETTING, method: "GET" } });
    return Response.json({ defaults: await modalityDefaults(await getDb()) });
  } catch (error) {
    return errorResponse(error);
  }
}

const Body = z.object({ modality: z.enum(MODALITY_GROUPS), viewer: z.enum(VIEWER_IDS).exclude(["dicomweb"]) });

export async function POST(request: Request) {
  try {
    const session = await checkedScreenWrite(request);
    const { modality, viewer } = await readJson(request, Body, 256);
    await requirePermission(session, "viewer.defaults", {
      action: "config_change",
      detail: { setting: SETTING, method: "POST", modality, to: viewer },
    });
    await auditWith(session, async (tx) => {
      const before = (await modalityDefaults(tx))[modality];
      await setModalityDefault(tx, session.actorId, modality, viewer);
      return {
        value: undefined,
        fields: { action: "config_change", detail: { setting: SETTING, modality, from: before, to: viewer } },
      };
    });
    return Response.json({ modality, viewer });
  } catch (error) {
    return errorResponse(error);
  }
}
