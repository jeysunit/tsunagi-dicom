import { renderSVG } from "uqr";
import { CodeForm } from "@/components/auth/auth-forms";

// TOTP の登録の画面（QR と、手で入れるための秘密）。秘密は登録を確かめるまで、セッションに暗号化して置く。
// QR はサーバーの側で SVG に描き、data: の画像で出す（外のサービスに秘密を渡さない）。
export function TotpEnrollment({
  secret,
  uri,
  csrfToken,
  askPassword = false,
}: {
  secret: string;
  uri: string;
  csrfToken: string;
  /** ログインした後の登録では、いまのパスワードも求める（再認証） */
  askPassword?: boolean;
}) {
  const svg = renderSVG(uri, { ecc: "M", border: 2, pixelSize: 4 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  const grouped = secret.replace(/(.{4})/g, "$1 ").trim();
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-label">
        <li>認証アプリで QR コードを読み取ります</li>
        <li>表示された 6 桁のコードを入力します</li>
      </ol>
      <img src={src} alt="二要素認証の QR コード" width={200} height={200} className="rounded bg-white" data-testid="totp-qr" />
      <p className="text-label">
        読み取れない場合は、次のキーを入力します：
        <br />
        <code className="font-mono text-value" data-testid="totp-secret" data-secret={secret}>
          {grouped}
        </code>
      </p>
      <CodeForm endpoint="/api/auth/totp/enroll" csrfToken={csrfToken} label="設定を完了" askPassword={askPassword} />
    </div>
  );
}
