import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { can } from "@/lib/auth/roles";
import { audit, AuthError } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { setStateFlag, STATE_FLAGS, STATE_PERMISSIONS } from "@/lib/study-state";

// 検査の状態（検像・読影・緊急・ブックマーク）を変える（docs/spec.md の 3.1）。
// BFF のデータベースだけを変え、画像サーバーの DICOM の値は書き換えない。変えたことを監査の記録に残す。
// 状態ごとに要る操作の権限は src/lib/study-state.ts の STATE_PERMISSIONS。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({ flag: z.enum(STATE_FLAGS), value: z.boolean() });

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { flag, value } = await readJson(request, Body, 256);
    if (!can(session.role, STATE_PERMISSIONS[flag])) {
      await audit(session, { action: "study_state", outcome: "denied", studyInstanceUid: uid, detail: { flag, value } });
      throw new AuthError(403, "この役割ではできない操作");
    }
    await setStateFlag(await getDb(), session.actorId, uid, flag, value);
    await audit(session, { action: "study_state", studyInstanceUid: uid, detail: { flag, value } });
    return Response.json({ flag, value });
  } catch (error) {
    return errorResponse(error);
  }
}
