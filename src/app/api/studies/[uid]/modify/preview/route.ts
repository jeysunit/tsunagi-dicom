import { z } from "zod";
import { checkedScreenWrite, readJson } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { studyUidParam } from "@/lib/api/study-param";
import { audit, requirePermission } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getConfig } from "@/lib/config";
import { checkCorrectionValues, correctionScope, type CorrectionValues } from "@/lib/correction-fields";
import { getDb } from "@/lib/db";
import { history, unresolved } from "@/lib/keep-uid-write";
import { signModifyConfirm } from "@/lib/pacs-ops";
import { CorrectionRefused, readSnapshot } from "@/lib/study-correction";
import { Kind, OrthancId, pendingContent, UNRESOLVED, Values } from "../shared";

// 値の修正の確かめの画面（docs/spec.md の 3.5。段 6）。直す検査（患者の属性の訂正では同じ患者 ID の全部の検査）・直す項目の
// 前と後の値・患者 ID の付け替えでは替え先の患者の値を Orthanc から読んで返し、見せた状態を token に結ぶ（./route.ts が照らす）。
// 直す値は患者の情報なので、URL に載せず本文で受ける（POST。Orthanc には書かない）。
// 同じ StudyInstanceUID の検査が複数あれば、選ぶための要点を添えて 409 を返す（画面は orthancId を添えて開き直す）。

type Context = { params: Promise<{ uid: string }> };

const Body = z.object({ kind: Kind, values: Values, orthancId: OrthancId.optional() });

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const uid = studyUidParam((await params).uid);
    const body = await readJson(request, Body, 16_384);
    const values = body.values as CorrectionValues;
    await requirePermission(session, "study.modify", { action: "modify", studyInstanceUid: uid, detail: { via: "preview", kind: body.kind } });
    const problem = checkCorrectionValues(values);
    if (problem) return Response.json({ error: problem.message, field: problem.field }, { status: 400 });
    const decided = correctionScope(body.kind, values);
    if ("problem" in decided) return Response.json({ error: decided.problem.message }, { status: 400 });
    const backend = getBackend();
    // 実行と同じく、結果不明・部分反映の書き換えが残っていれば、確かめの画面を出さない（照らし合わせは実行の時に列の中で行う）
    const pending = unresolved(await history());
    if ((body.kind === "attribute" ? pending.length > 0 : pending.some((d) => d.StudyInstanceUID === uid || d.group?.includes(uid)))
      || (await pendingContent(await getDb(), uid)).length > 0) {
      return Response.json({ error: UNRESOLVED }, { status: 409 });
    }
    if (body.kind === "attribute") {
      const settings = await backend.keepUidSettings();
      if (!settings.overwriteInstances || (decided.scope === "reassign" && !settings.lockMetadata)) {
        return Response.json({ error: "画像サーバーの設定が足りないため、患者情報修正はできません（OverwriteInstances・UserMetadata）" }, { status: 409 });
      }
    }
    let snap;
    try {
      snap = await readSnapshot(backend, uid, body.kind, values, body.orthancId);
    } catch (e) {
      if (e instanceof CorrectionRefused) {
        // 同じ UID の検査の一覧は、患者 ID と氏名を見せるので記録する
        if (e.reason === "ambiguous") {
          await audit(session, { action: "view_study", studyInstanceUid: uid, detail: { via: "modify_preview_candidates" } });
        }
        return Response.json({ error: e.message, ...e.extra }, { status: e.status });
      }
      throw e;
    }
    // 同じ患者のほかの検査に、結果不明・部分反映の中身の訂正が残っていれば、確かめの画面を出さない
    for (const st of snap.studies) {
      if (st.info.studyInstanceUid !== uid && (await pendingContent(await getDb(), st.info.studyInstanceUid)).length > 0) {
        return Response.json({ error: UNRESOLVED }, { status: 409 });
      }
    }
    // 確かめの画面で患者の値を見せるので、詳細を開いたのと同じく記録する
    await audit(session, {
      action: "view_study",
      patientId: snap.selected.instances[0]!.PatientID,
      studyInstanceUid: uid,
      detail: { via: "modify_preview", kind: snap.kind, scope: snap.scope, studies: snap.studies.length },
    });
    const confirmToken = signModifyConfirm(
      { actorId: session.actorId, studyInstanceUid: uid, orthancId: snap.selected.orthancId, kind: snap.kind, scope: snap.scope, state: snap.state },
      getConfig().sessionSecret,
    );
    return Response.json({
      confirmToken,
      kind: snap.kind,
      scope: snap.scope,
      orthancId: snap.selected.orthancId,
      fields: snap.fields,
      studies: snap.studies.map((st) => ({
        studyInstanceUid: st.info.studyInstanceUid,
        studyDate: st.info.studyDate,
        studyDescription: st.info.studyDescription,
        accessionNumber: st.info.accessionNumber,
        instanceCount: st.instances.length,
        // 画像どうしで値の揃っていない項目（確かめの画面に、揃っていないことを出す）
        mixed: st.mixed,
        // この検査の、直す項目の修正前の値（先頭の画像。患者の全部の検査に当てるとき、検査ごとに違う値も確かめの画面に出す）
        ...(snap.kind === "attribute"
          ? { before: Object.fromEntries(Object.keys(snap.fields).map((f) => [f, st.instances[0]![f as keyof (typeof st.instances)[number]]])) }
          : {}),
      })),
      ...(snap.target ? { target: { exists: snap.target.exists, ...snap.target.attributes } } : {}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
