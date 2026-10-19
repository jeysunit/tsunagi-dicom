import { RequestError } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { sameOriginRequest } from "@/lib/api/same-origin";
import { studyUidParam } from "@/lib/api/study-param";
import { audit, requirePermission, requireSession } from "@/lib/auth/session";
import { getConfig } from "@/lib/config";
import { availableViewers, isViewerId, viewerUrl } from "@/lib/viewers";

// 検査をビューアで開く（docs/spec.md の 3.2）。どの検査をどのビューアで開いたかを監査の記録に残してから、
// ビューアの URL へ移す（302）。ビューアは BFF の中継（/api/dicom-web）から画像を取るように、ビューアの側で設定する。
// DICOMweb の URL（研究の道具に渡すもの）は、移さずに URL を返す。その URL はこのアプリの監査の外。
// このアプリの画面（同じ origin）から開いた要求だけを受ける。同じサイトの別の origin・別のサイトからの要求
// （Sec-Fetch-Site が same-origin でない、Origin が違う）は、開いた記録を作らずに 403（利用者が分かれば断ったことを記録する）。


export async function GET(request: Request) {
  try {
    const session = await requireSession();
    const url = new URL(request.url);
    if (!sameOriginRequest(request)) {
      await audit(session, {
        action: "open_viewer",
        outcome: "denied",
        detail: { reason: "not-same-origin", site: request.headers.get("sec-fetch-site")?.slice(0, 32) ?? null },
      });
      throw new RequestError(403, "このアプリの画面から開いた要求だけを受ける");
    }
    const uid = studyUidParam(url.searchParams.get("study"));
    const viewer = url.searchParams.get("viewer");
    await requirePermission(session, "image.retrieve", {
      action: "open_viewer",
      studyInstanceUid: uid,
      detail: { viewer: viewer?.slice(0, 32) ?? null },
    });
    const config = getConfig();
    const info = availableViewers(config.viewers).find((v) => v.id === viewer);
    if (!isViewerId(viewer) || !info) throw new RequestError(400, "このビューアは設定されていない");

    const target = viewerUrl(viewer, config.viewers, uid, `${url.origin}/api/dicom-web`);
    if (!target) throw new RequestError(400, "このビューアは設定されていない");
    await audit(session, { action: "open_viewer", studyInstanceUid: uid, detail: { viewer } });

    if (info.kind === "copy") return Response.json({ url: target, outsideAudit: true });
    return new Response(null, { status: 302, headers: { location: target, "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
