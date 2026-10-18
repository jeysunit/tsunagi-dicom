import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { auditWith, requirePermission } from "@/lib/auth/session";
import { setStateFlag, STATE_FLAGS, STATE_PERMISSIONS } from "@/lib/study-state";

// 検査の状態（検像・読影・緊急・ブックマーク）を変える（docs/spec.md の 3.1）。
// BFF のデータベースだけを変え、画像サーバーの DICOM の値は書き換えない。
// - 変更と監査の記録を1つの transaction で書く（どちらかが失敗すれば両方とも書かない）。
// - 画面は読んだ時の版（version）を添える。ほかの利用者が先に変えていれば書かずに 409（画面は読み直す）。
// - 役割に権限が無ければ、断ったことを記録して 403。状態ごとの権限は src/lib/study-state.ts の STATE_PERMISSIONS。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({
  flag: z.enum(STATE_FLAGS),
  value: z.boolean(),
  version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { flag, value, version } = await readJson(request, Body, 256);
    await requirePermission(session, STATE_PERMISSIONS[flag], {
      action: "study_state",
      studyInstanceUid: uid,
      detail: { flag, value },
    });
    const result = await auditWith(session, async (tx) => {
      const r = await setStateFlag(tx, session.actorId, uid, flag, value, version);
      return {
        value: r,
        fields: {
          action: "study_state",
          outcome: r.kind === "ok" ? "success" : "denied",
          studyInstanceUid: uid,
          detail: {
            flag,
            value,
            ...(r.kind === "conflict" ? { reason: "conflict", expected: version, current: r.version } : {}),
          },
        },
      };
    });
    if (result.kind === "conflict") {
      return Response.json({ error: "ほかの利用者が先に変えた。読み直した値を確かめる", version: result.version }, { status: 409 });
    }
    return Response.json({ flag, value, version: result.version });
  } catch (error) {
    return errorResponse(error);
  }
}
