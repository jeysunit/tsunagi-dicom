/**
 * このアプリの画面（同じ origin）から開いた GET の要求か。Sec-Fetch-Site を送らない古いブラウザ・道具は Origin だけで見る。
 * ビューアで開く（/api/viewers/open）・書き出し（/api/studies/{uid}/export）のように、GET でも記録や持ち出しを伴う道に使う
 */
export function sameOriginRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === new URL(request.url).origin;
}
