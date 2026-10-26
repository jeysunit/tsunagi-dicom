import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { auditIf, requirePermission } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { enqueue, history, unresolved, verify } from "@/lib/keep-uid-write";
import { visible } from "../../../../../hl7-receiver/visible";
const Body = z.object({ writeId: z.uuid(), note: z.string().trim().min(1).max(500) }).strict();

/** 管理者の確認内容と全画像の読み直しを記録する。書き換えは呼ばない（design.md §10）。 */
export async function POST(request: Request) {
  try {
    const session = await checkedScreenWrite(request);
    const { writeId, note } = await readJson(request, Body, 4096);
    await requirePermission(session, "pacs.reconcile", { action: "hl7", detail: { writeId, via: "resolve" } });
    return await enqueue(async () => {
      const rows = await history();
      const d = unresolved(rows).find(d => d.writeId === writeId);
      if (!d) {
        return Response.json({ error: "この書き換えは無いか、結果が確定しています" }, { status: 409 });
      }
      // 検査情報修正（中身の訂正）は、仕事の終わりを確かめる道（/api/studies/{uid}/modify/resolve）で解く
      if ((d as { content?: unknown }).content === true) {
        return Response.json({ error: "検査情報修正の結果は、その検査の検査情報修正から確認済みとして解除してください" }, { status: 409 });
      }
      // Orthanc の仕事がまだ動いていれば解かない（BFF が結果不明にした後も、Orthanc は書き換え続けうる。解いた後の書き換えと
      // 重なると、先の仕事が後の値を上書きする）。仕事の状態を読めなければ、ここで投げて解かない
      const dispatch = rows.find(r => r.detail?.event === "dispatch" && r.detail?.writeId === writeId);
      if (typeof dispatch?.detail?.jobId === "string") {
        const job = await getBackend().jobStatus(dispatch.detail.jobId);
        if (job && job.state !== "Success" && job.state !== "Failure") {
          return Response.json({ error: "この書き換えのジョブはまだ動いています。終わってから確認してください" }, { status: 409 });
        }
      } else if (await getBackend().unfinishedModifyJobs() > 0) {
        // 仕事の ID が分からない（Orthanc が受けた後に答えが失われた・記録に失敗した・書き換えの組）。この書き換えの仕事が
        // まだ動いているかもしれないので、Orthanc に終わっていない書き換えの仕事が1つでもあれば解かない
        return Response.json({ error: "画像サーバーに、終わっていない書き換えのジョブがあります。終わってから確認してください" }, { status: 409 });
      }
      const checked = await verify(getBackend(), d);
      // 画面の値の修正（患者情報修正）の書き換えも、同じ部品の行なので、ここで解く。照らし合わせの行は、書き換えの操作の行に書く
      const action = rows.find(r => (r.detail?.event === "request" || r.detail?.event === "group") && r.detail?.writeId === writeId)?.action ?? "hl7";
      await auditIf(session, async () => ({
        value: true,
        fields: {
          action,
          outcome: checked.matchesAfter ? "success" : "failed",
          patientId: d.after[0]?.PatientID,
          studyInstanceUid: d.StudyInstanceUID,
          detail: {
            event: "reconcile",
            writeId,
            manual: true,
            ...checked,
            note: visible(note)
          }
        }
      }));
      return Response.json({ writeId, ...checked });
    });
  } catch (e) {
    return errorResponse(e);
  }
}
