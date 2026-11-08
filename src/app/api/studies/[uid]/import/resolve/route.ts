import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { auditIf, requirePermission } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { BackendError, type Backend } from "@/lib/backend/types";
import { getDb } from "@/lib/db";
import { IMPORT_SETTLE_MS, isRequestId, isUnresolved, requestOutcome, rowsOfRequest, type RequestRow } from "@/lib/pacs-ops";
import { cleanupTarget, requestFile } from "@/app/api/import/shared";

// 結果の分からないインポート・入れた画像を消せなかったインポートを、管理者が手で解く（docs/spec.md の 3.5「取り込み」。段 6）。
// 管理者だけ（pacs.reconcile）。削除の手で解く道（delete/resolve）と同じ形。
// 状態の確認（GET /api/import）は、入ったと読めて値が合うときと、消す画像がもう無いと読めたときだけ自動で解く。
// それ以外（見つけた画像の値がファイルと違う・消せなかった画像が残る・入ったと読めない）は結果不明のまま、同じ検査の
// インポートを止め続けるので、管理者が Orthanc の側で確認し、「成功」か「失敗」を指定し、確認した内容を書いて解く。
// 解くときに Orthanc を読み、画像（消す画像の ID か、「求めた」の行の SOP Instance UID）があるかを記録に残す（phase は reconcile）。
// 「成功」は、画像があると読めたときだけ記録する。Orthanc には書き込みを求めない（印も付けない）。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({
  requestId: z.string().refine(isRequestId, "要求ID が正しくありません"),
  /** 管理者が確認した結果。success：このインポートの画像が入った・failed：入っていない（入らなかったことにする） */
  outcome: z.enum(["success", "failed"]),
  /** どこで・どう確認したか（必須） */
  note: z.string().trim().min(1, "確認内容を入力してください").max(500),
});

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const { requestId, outcome, note } = await readJson(request, Body, 4096);
    await requirePermission(session, "pacs.reconcile", { action: "import", studyInstanceUid: uid, detail: { requestId, via: "resolve" } });
    const db = await getDb();
    const before = await rowsOfRequest(db, "import", requestId, uid);
    const o = requestOutcome(before);
    if (o.phase === "none" || o.studyInstanceUid !== uid) {
      return Response.json({ error: "この検査に、その要求ID のインポートはありません" }, { status: 404 });
    }
    const present = await importedPresence(getBackend(), before);
    if (outcome === "success" && !present.present) {
      return Response.json({ error: "画像サーバーにこの画像が見つかりません。成功として記録できません" }, { status: 409 });
    }
    type Resolve = "resolved" | "settled" | "running";
    const result = await auditIf<Resolve>(session, async (tx) => {
      const rows = await rowsOfRequest(tx, "import", requestId, uid);
      const now = requestOutcome(rows);
      if (!isUnresolved(now)) return { value: "settled", fields: null };
      // 結果の行が無い要求は、元の処理がまだ Orthanc へ送っている・照らしている・消しているかもしれない。
      // 決めた時間（IMPORT_SETTLE_MS）を過ぎるまでは解かない（結果不明の行があれば、元の処理は終わっている）
      const age = now.requestedAt ? Date.now() - now.requestedAt.getTime() : 0;
      if (now.phase === "requested" && age <= IMPORT_SETTLE_MS) return { value: "running", fields: null };
      const file = requestFile(rows);
      return {
        value: "resolved" as const,
        fields: {
          action: "import",
          outcome,
          patientId: rows.find((r) => r.patientId)?.patientId ?? null,
          studyInstanceUid: uid,
          detail: {
            requestId,
            ...(file?.batch ? { batch: file.batch } : {}),
            ...(file ? { sopInstanceUid: file.sopInstanceUid } : {}),
            phase: "reconcile",
            manual: true,
            instancePresent: present.present,
            ...(present.orthancInstanceId ? { orthancInstanceId: present.orthancInstanceId } : {}),
            ...(present.orthancStudyId ? { orthancStudyId: present.orthancStudyId } : {}),
            note,
          },
        },
      };
    });
    if (result === "settled") return Response.json({ error: "このインポートの結果は確定しています" }, { status: 409 });
    if (result === "running") {
      return Response.json({ error: "このインポートはまだ処理中です。終わってから確認してください" }, { status: 409 });
    }
    return Response.json({ requestId, outcome: outcome === "success" ? "stored" : "failed", instancePresent: present.present });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * このインポートの画像が Orthanc にあるか。入れた画像を消そうとした要求は、消す画像（Orthanc の ID）を指定して読む。
 * それ以外は「求めた」の行の SOP Instance UID で引き当てる（2 つ以上あれば、あるとする）。読めなければ投げる（解かない）
 */
async function importedPresence(
  backend: Backend,
  rows: readonly RequestRow[],
): Promise<{ present: boolean; orthancInstanceId?: string; orthancStudyId?: string }> {
  const cleanup = cleanupTarget(rows);
  if (cleanup) return (await backend.instanceExists(cleanup)) ? { present: true, orthancInstanceId: cleanup } : { present: false };
  const file = requestFile(rows);
  if (!file) return { present: false };
  try {
    const found = await backend.findInstanceStudy(file.sopInstanceUid);
    return found ? { present: true, orthancInstanceId: found.instanceId, orthancStudyId: found.orthancStudyId } : { present: false };
  } catch (error) {
    if (error instanceof BackendError && error.status === 409) return { present: true };
    throw error;
  }
}
