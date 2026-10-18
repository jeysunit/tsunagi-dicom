import "server-only";
import { createHttpBackend } from "@/lib/backend/http";
import { createMockBackend } from "@/lib/backend/mock";
import type { Backend } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";

let shared: Backend | undefined;

/** 設定（BACKEND_KIND・BACKEND_MOCK）に合わせた画像サーバー。サーバーの側だけで使う */
export function getBackend(): Backend {
  if (!shared) {
    const { backend } = getConfig();
    shared = backend.mock ? createMockBackend(backend.kind) : createHttpBackend(backend);
  }
  return shared;
}
