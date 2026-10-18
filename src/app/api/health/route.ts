// コンテナの生きているかの確かめ用。画像サーバーにはつながない。
export function GET() {
  return Response.json({ status: "ok" });
}
