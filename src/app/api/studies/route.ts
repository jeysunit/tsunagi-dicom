import { errorResponse } from "@/lib/api/respond";
import { audit, getSession } from "@/lib/auth/session";
import { getBackend } from "@/lib/backend";

// 検査の件数と一覧（BFF の中継）。資格情報はサーバーの側だけで使う。
export async function GET() {
  try {
    const session = await getSession();
    const backend = getBackend();
    const [count, studies] = await Promise.all([backend.countStudies(), backend.searchStudies()]);
    await audit(session, { action: "search", detail: { via: "api", results: studies.length } });
    return Response.json({ count, studies });
  } catch (error) {
    return errorResponse(error);
  }
}
