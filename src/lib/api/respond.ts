import "server-only";
import { BackendError } from "@/lib/backend/types";

/** 失敗をブラウザへ返す。中の原因（URL・資格情報を含みうる）は出さない */
export function errorResponse(error: unknown): Response {
  if (error instanceof BackendError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error(error);
  return Response.json({ error: "サーバーの中で失敗した" }, { status: 500 });
}
