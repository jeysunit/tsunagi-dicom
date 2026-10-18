import { errorResponse } from "@/lib/api/respond";
import { decideWrite, isWriteMethod } from "@/lib/auth/write-guard";
import { audit, getSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { getConfig } from "@/lib/config";

// DICOMweb の中継（QIDO-RS・WADO-RS。STOW-RS などの書き込みは書き込みの止めを通す）。
// ブラウザの cookie・Authorization は画像サーバーへ渡さず、画像サーバーの資格情報はサーバーの側で付ける。

type Context = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Context): Promise<Response> {
  try {
    const { path } = await params;
    const session = await getSession();
    const method = request.method.toUpperCase();

    if (isWriteMethod(method)) {
      const decision = decideWrite(getConfig().auth);
      if (!decision.allowed) {
        await audit(session, { action: "write", outcome: "denied", detail: { method, path: path.join("/"), reason: "dev" } });
        return Response.json({ error: decision.reason }, { status: 403 });
      }
      await audit(session, { action: "write", detail: { method, path: path.join("/") } });
    }

    return await getBackend().relayDicomweb({
      method,
      segments: path,
      search: new URL(request.url).search,
      accept: request.headers.get("accept"),
      contentType: request.headers.get("content-type"),
      body: isWriteMethod(method) ? await request.arrayBuffer() : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
