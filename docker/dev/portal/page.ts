// 開発の一式の入口のページ（3つの画面へのリンク）。ポート番号は compose の変数と同じ値を環境変数で受けて埋める。

export interface PortalPorts {
  tsunagi: number;
  dtg: number;
  ris: number;
}

// compose.yaml の既定のポートと同じ値（tests/unit/dev-portal.test.ts が compose.yaml と突き合わせる）
export const DEFAULT_PORTS: PortalPorts = { tsunagi: 3000, dtg: 18080, ris: 18081 };

export const portalLinks = (ports: PortalPorts) => [
  { name: "tsunagi-dicom", href: `http://127.0.0.1:${ports.tsunagi}/` },
  { name: "DICOM テストジェネレーター", href: `http://127.0.0.1:${ports.dtg}/` },
  { name: "RIS エミュレーター", href: `http://127.0.0.1:${ports.ris}/` },
];

export function renderPortal(ports: PortalPorts): string {
  const items = portalLinks(ports)
    .map((l) => `      <li><a href="${l.href}">${l.name}</a></li>`)
    .join("\n");
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>tsunagi 開発環境</title>
    <link rel="stylesheet" href="/tokens.css" />
    <style>
      body { margin: 0; background: var(--color-background); color: var(--color-foreground); font: 400 var(--text-base) / 21px var(--font-sans); }
      main { max-width: var(--w-login); margin: var(--space-8) auto; padding: 0 var(--space-6); }
      h1 { margin: 0 0 var(--space-4); color: var(--color-value); font-size: var(--text-xl); line-height: 28px; font-weight: 700; }
      ul { margin: 0; padding: 0; list-style: none; border: 1px solid var(--color-border); border-radius: var(--radius-md); }
      li + li { border-top: 1px solid var(--color-border); }
      a { display: block; padding: var(--space-3) var(--space-4); color: var(--color-link); font-weight: 700; text-decoration: none; }
      a:hover { background: var(--color-hover); }
      a:active { background: var(--color-pressed); }
      a:focus-visible { outline: 2px solid var(--color-ring); outline-offset: -2px; }
    </style>
  </head>
  <body>
    <main>
      <h1>tsunagi 開発環境</h1>
      <ul>
${items}
      </ul>
    </main>
  </body>
</html>
`;
}
