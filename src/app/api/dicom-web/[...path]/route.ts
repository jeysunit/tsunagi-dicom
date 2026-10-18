import { errorResponse } from "@/lib/api/respond";
import { can } from "@/lib/auth/roles";
import { audit, getAuthState, requireSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";
import { relayWadoRs } from "@/lib/relay";

// DICOMweb の中継。通すのはビューアが画像を取る道（WADO-RS の読み取り）だけ（src/lib/relay.ts）。
// ブラウザの cookie・Authorization は画像サーバーへ渡さず、画像サーバーの資格情報はサーバーの側で付ける。

type Context = { params: Promise<{ path: string[] }> };

async function handle(request: Request, { params }: Context): Promise<Response> {
  try {
    const { path } = await params;
    // 画面のロック中は 423。利用者が分かるので、断ったことを記録に残す
    const state = await getAuthState();
    if (state.kind === "locked") {
      await audit(state.session, {
        action: "retrieve",
        outcome: "denied",
        detail: { method: request.method.toUpperCase(), path: path.join("/").slice(0, 512), reason: "screen-locked" },
      });
    }
    // ログインしていない（401。利用者が分からないので記録しない）・画面のロック中（423）は、ここで断る。
    // 役割の確かめは relayWadoRs（403）
    const session = await requireSession();
    return await relayWadoRs(
      {
        method: request.method,
        segments: path,
        search: new URL(request.url).search,
        accept: request.headers.get("accept"),
      },
      {
        backend: getBackend(),
        allowed: can(session.role, "image.retrieve"),
        record: (fields) => audit(session, fields),
      },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export const GET = handle;
export const HEAD = handle;
// 書き込みの道は段 4 まで無い。断ったことを記録に残すため、405 を返す処理を置く
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
