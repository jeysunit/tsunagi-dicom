// コンテナの生きているかの確認用。画像サーバーにはつながない。
export function GET() {
  return Response.json({ status: "ok" });
}
