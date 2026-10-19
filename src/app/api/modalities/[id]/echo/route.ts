import { checkedScreenWrite } from "@/lib/api/auth-route";
import { errorResponse } from "@/lib/api/respond";
import { audit, requirePermission } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { isModalityName } from "@/lib/backend/orthanc-rest";
import { BackendError } from "@/lib/backend/types";
import { clip } from "@/lib/pacs-ops";

// つながるかの確かめ（docs/spec.md の 3.3。段 4）。Orthanc から機器へ C-ECHO を送る（/modalities/{id}/echo）。
// Orthanc の中身は変えないが、Orthanc に機器への通信をさせる操作なので、状態を変える要求と同じく CSRF を確かめる。
// 結果（つながった・つながらない）を監査の記録（echo）に残す。断った要求も残す。

type Context = { params: Promise<{ id: string }> };

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export async function POST(request: Request, { params }: Context) {
  try {
    const session = await checkedScreenWrite(request);
    const raw = (await params).id;
    const id = decoded(raw);
    await requirePermission(session, "modality.check", { action: "echo", detail: { modality: clip(id ?? raw) } });
    if (id === null || !isModalityName(id)) return Response.json({ error: "機器の名前の形が誤り" }, { status: 400 });
    let ok: boolean;
    try {
      ok = await getBackend().echoModality(id);
    } catch (error) {
      await audit(session, {
        action: "echo",
        outcome: "failed",
        detail: { modality: id, status: error instanceof BackendError ? error.status : 502 },
      });
      throw error;
    }
    await audit(session, { action: "echo", outcome: ok ? "success" : "failed", detail: { modality: id, connected: ok } });
    return Response.json({ modality: id, connected: ok });
  } catch (error) {
    return errorResponse(error);
  }
}
