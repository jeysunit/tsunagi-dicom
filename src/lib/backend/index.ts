import "server-only";
import { createHttpBackend } from "@/lib/backend/http";
import { createMockBackend } from "@/lib/backend/mock";
import type { Backend } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";

let shared: Backend | undefined;

/** 設定（BACKEND_MOCK）に合わせた Orthanc。サーバーの側だけで使う */
export function getBackend(): Backend {
  if (!shared) {
    const { backend } = getConfig();
    shared = backend.mock ? createMockBackend() : createHttpBackend(backend);
  }
  return shared;
}
