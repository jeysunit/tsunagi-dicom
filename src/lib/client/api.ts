// 画面から BFF の画面の API を読む。画面のロック中（423）は頁を読み直してロックの画面にし、
// ログインしていない（401）ならログインの頁へ移す（src/components/auth/lock-guard.tsx と同じ扱い）。

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function handleAuthStatus(status: number): void {
  if (status === 423) window.location.reload();
  else if (status === 401) window.location.assign("/login");
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  if (!res.ok) {
    handleAuthStatus(res.status);
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(res.status, typeof body.error === "string" ? body.error : `読めなかった（${res.status}）`);
  }
  return (await res.json()) as T;
}

export { handleAuthStatus };
