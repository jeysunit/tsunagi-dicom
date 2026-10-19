import "server-only";
import { RequestError } from "@/lib/api/auth-route";
import { AuthFailure } from "@/lib/auth/local-auth";
import { AuthError } from "@/lib/auth/session";
import { BackendError } from "@/lib/backend/types";

/** 失敗をブラウザへ返す。中の原因（URL・資格情報を含みうる）は出さない */
export function errorResponse(error: unknown): Response {
  if (error instanceof BackendError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof AuthError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof AuthFailure || error instanceof RequestError) {
    const retryAfter = error instanceof AuthFailure ? error.retryAfterSeconds : undefined;
    return Response.json(
      { error: error.message, ...(error.problems.length > 0 ? { problems: error.problems } : {}) },
      { status: error.status, ...(retryAfter !== undefined ? { headers: { "retry-after": String(retryAfter) } } : {}) },
    );
  }
  console.error(error);
  return Response.json({ error: "サーバーでエラーが発生しました" }, { status: 500 });
}
