// 画面から BFF の状態を変える API を呼ぶ。CSRF の token を x-csrf-token に付ける（ログインの前は無い）。

export interface PostResult {
  ok: boolean;
  status: number;
  data: { error?: string; problems?: string[]; next?: string; [key: string]: unknown };
}

export async function postJson(
  url: string,
  body: unknown,
  csrfToken?: string,
  method: "POST" | "PATCH" = "POST",
): Promise<PostResult> {
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...(csrfToken ? { "x-csrf-token": csrfToken } : {}) },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const data = (await res.json().catch(() => ({}))) as PostResult["data"];
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "サーバーにつながらなかった" } };
  }
}

/** 誤りの文言（理由の並びがあれば添える） */
export function errorText(result: PostResult): string {
  const base = result.data.error ?? `失敗した（${result.status}）`;
  return result.data.problems?.length ? `${base}：${result.data.problems.join("・")}` : base;
}
