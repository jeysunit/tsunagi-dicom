import "server-only";
import { createHttpBackend } from "@/lib/backend/http";
import { createMockBackend } from "@/lib/backend/mock";
import { withRelayAccept } from "@/lib/backend/relay-path";
import type { Backend } from "@/lib/backend/types";
import { getConfig } from "@/lib/config";

let shared: Backend | undefined;

/** 設定（BACKEND_MOCK）に合わせた Orthanc。サーバーの側だけで使う */
export function getBackend(): Backend {
  if (!shared) {
    const { backend } = getConfig();
    // 実の接続は http.ts の中で Accept を決める。モックは Orthanc と同じく受け付けない Accept を断るので、同じ決め方を前に付ける
    shared = backend.mock ? withRelayAccept(createMockBackend()) : createHttpBackend(backend);
  }
  return shared;
}
