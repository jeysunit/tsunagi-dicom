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

/** 通信が切れた（ブラウザーが fetch を果たせなかった）ときの文。ブラウザーの英語の誤り（Failed to fetch）を画面に出さない */
export const NETWORK_ERROR_MESSAGE = "サーバーに接続できません";

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
  } catch (e) {
    // 取り消し（画面を離れた・条件を替えた）は、そのまま渡す。それ以外の通信の誤りは、status 0 の ApiError にする
    if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError")) throw e;
    throw new ApiError(0, NETWORK_ERROR_MESSAGE);
  }
  if (!res.ok) {
    handleAuthStatus(res.status);
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    throw new ApiError(res.status, typeof body.error === "string" ? body.error : `読み込めませんでした（${res.status}）`);
  }
  return (await res.json()) as T;
}

export { handleAuthStatus };
