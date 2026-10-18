import { renderSVG } from "uqr";
import { CodeForm } from "@/components/auth/auth-forms";

// TOTP の登録の画面（QR と、手で入れるための秘密）。秘密は登録を確かめるまで、セッションに暗号化して置く。
// QR はサーバーの側で SVG に描き、data: の画像で出す（外のサービスに秘密を渡さない）。
export function TotpEnrollment({ secret, uri, csrfToken }: { secret: string; uri: string; csrfToken: string }) {
  const svg = renderSVG(uri, { ecc: "M", border: 2, pixelSize: 4 });
  const src = `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
  const grouped = secret.replace(/(.{4})/g, "$1 ").trim();
  return (
    <div className="space-y-4">
      <ol className="list-decimal space-y-1 pl-5 text-label">
        <li>認証のアプリ（TOTP。RFC 6238 に対応したもの）で、この QR を読む。</li>
        <li>アプリに出た 6 桁の番号を入れて、登録を確かめる。</li>
      </ol>
      <img src={src} alt="TOTP の登録の QR" width={200} height={200} className="rounded bg-white" data-testid="totp-qr" />
      <p className="text-label">
        QR を読めないときは、次の秘密を手で入れる（30 秒・6 桁・SHA1）：
        <br />
        <code className="font-mono text-value" data-testid="totp-secret" data-secret={secret}>
          {grouped}
        </code>
      </p>
      <CodeForm endpoint="/api/auth/totp/enroll" csrfToken={csrfToken} label="登録する" />
    </div>
  );
}
