import { readdirSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CountRow } from "@/components/ui/count-row";
import { PatientBanner } from "@/components/ui/patient-banner";
import { StatusBadge, type StatusKind } from "@/components/ui/status-badge";

// 画面のデザインシステム（docs/design-system）を機械で守る検査。
// 1. 色の直書き（#hex・rgb() など・Tailwind の色名）を、トークンを定義する所以外で落とす（例外は理由つきの一覧）
// 2. docs/design-system/tokens.md の色の表が、src/app/globals.css の値と一致する
// 3. 部品（状態の札・件数の行・患者バナー）の決まり

const css = readFileSync("src/app/globals.css", "utf8");

/** 色の直書きを許す場所の一覧。載せるのは理由があるものだけ。理由が消えたら一覧から外す（使われない例外は落とす） */
const EXCEPTIONS: { file: string; match: string; reason: string }[] = [
  {
    file: "src/components/auth/totp-enrollment.tsx",
    match: "bg-white",
    reason: "QR コードは読み取りのため、地の色に関わらず白地にする（暗い地でも読めるように）",
  },
  {
    file: "src/components/ui/button.tsx",
    match: "rgb(0_0_0/0.2)",
    reason: "押している間の内側の影。黒の透過で、地の色に関わらず同じ濃さにする（影のトークンを決める周で置き換える）",
  },
];

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
// Tailwind の任意の値は空白を `_` で書く（`4px_rgb(…)`）ので、直前が英数字でないことで区切る（\b は `_` を字に数える）
const COLOR_FUNCTION = /(?<![A-Za-z0-9])(?:rgba?|hsla?|oklch|oklab|lab|lch|hwb|color)\([^)]*\)/gi;
// 色を取るユーティリティの接頭辞（border-t-… などの向きつきと ring-offset-… を含む）
const COLOR_PREFIX =
  "(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|outline|divide|decoration|accent|caret|from|to|via|placeholder|shadow)";
const PALETTE_CLASS = new RegExp(
  `\\b${COLOR_PREFIX}-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\\d{2,3}\\b`,
  "g",
);
const PLAIN_CLASS = new RegExp(`\\b${COLOR_PREFIX}-(?:white|black)\\b`, "g");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.(?:tsx?|css)$/.test(e.name))
    .map((e) => `${e.parentPath}/${e.name}`.replaceAll("\\", "/"))
    .filter((p) => !p.startsWith("src/generated/"));
}

/** コメントを除く（ここの色の説明は直書きに数えない）。文字列（' " `）の中の `//` や `/*` は、コメントとして扱わず残す */
function stripComments(text: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const two = text.slice(i, i + 2);
    if (quote) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === quote) quote = "";
    } else if (two === "/*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else if (two === "//") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1;
    } else {
      if (c === '"' || c === "'" || c === "`") quote = c;
      out += c;
    }
  }
  return out;
}

/** globals.css から、トークンを定義する塊（`@theme { … }` と `[data-theme="dark"] { … }`）を除く */
function withoutTokenBlocks(text: string): string {
  let out = text;
  for (const selector of ["@theme", '[data-theme="dark"]']) {
    const start = out.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThanOrEqual(0);
    out = out.slice(0, start) + out.slice(out.indexOf("}", start) + 1);
  }
  return out;
}

function directColors(file: string): string[] {
  const raw = readFileSync(file, "utf8");
  const text = stripComments(file.endsWith("globals.css") ? withoutTokenBlocks(raw) : raw);
  return [HEX, COLOR_FUNCTION, PALETTE_CLASS, PLAIN_CLASS].flatMap((re) => text.match(re) ?? []);
}

describe("色の直書き", () => {
  it("トークンを定義する所以外に、#hex・rgb() などの色や Tailwind の色名が無い（例外の一覧に載るものを除く）", () => {
    const found: string[] = [];
    for (const file of sourceFiles("src")) {
      for (const hit of directColors(file)) {
        if (!EXCEPTIONS.some((e) => e.file === file && e.match === hit)) found.push(`${file}: ${hit}`);
      }
    }
    expect(found, "色はトークン（src/app/globals.css の --color-*）で指定する。足りなければ docs/design-system に足す PR を先に出す").toEqual([]);
  });

  it("例外の一覧は、どれも今のコードに残っている（使われなくなった例外は外す）", () => {
    for (const e of EXCEPTIONS) {
      expect(e.reason.length, e.file).toBeGreaterThan(0);
      expect(directColors(e.file), `${e.file}: ${e.match}`).toContain(e.match);
    }
  });

  it("検査の目はある：直書きの例を渡すと拾う", () => {
    const sample = stripComments('const a = "#4b4fbf"; // #fff\nclassName="bg-red-500 text-white" style={{ color: "rgb(0 0 0)" }}');
    const hits = [HEX, COLOR_FUNCTION, PALETTE_CLASS, PLAIN_CLASS].flatMap((re) => sample.match(re) ?? []);
    expect(hits.sort()).toEqual(["#4b4fbf", "bg-red-500", "rgb(0 0 0)", "text-white"].sort());
  });

  it("検査の目はある：向きつきの枠・ring-offset・caret・placeholder の色名も拾う", () => {
    expect("RGB(0 0 0) color(srgb 1 0 0)".match(COLOR_FUNCTION)).toEqual(["RGB(0 0 0)", "color(srgb 1 0 0)"]);
    const sample = "border-t-red-500 ring-offset-blue-500 caret-white placeholder-black md:hover:bg-gray-100";
    const hits = [PALETTE_CLASS, PLAIN_CLASS].flatMap((re) => sample.match(re) ?? []);
    expect(hits.sort()).toEqual(["border-t-red-500", "caret-white", "bg-gray-100", "placeholder-black", "ring-offset-blue-500"].sort());
  });

  it("コメントの除き方：文字列の中の // や /* は残し、その後ろの違反も見落とさない", () => {
    const hits = (s: string) => [PALETTE_CLASS].flatMap((re) => stripComments(s).match(re) ?? []);
    expect(hits('const text = "a //"; const cls = "bg-red-500";')).toEqual(["bg-red-500"]);
    expect(hits('const a = "/*"; const cls = "text-blue-600"; const b = "*/";')).toEqual(["text-blue-600"]);
    expect(hits("/* bg-red-500 */ // text-blue-600\nconst ok = 1;")).toEqual([]);
  });
});

function cssTokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("}", start));
  // 値は 6 桁の #hex に限る（別の書き方に替えたら、この検査が拾えなくなるので、数えて確かめる）
  const decls = [...body.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)];
  for (const d of decls) expect(d[2]!.trim(), `--color-${d[1]}`).toMatch(/^#[0-9a-fA-F]{6}$/);
  return Object.fromEntries(decls.map((d) => [d[1]!, d[2]!.trim().toLowerCase()]));
}

describe("docs/design-system/tokens.md と globals.css の色", () => {
  const light = cssTokens("@theme");
  const dark = { ...light, ...cssTokens('[data-theme="dark"]') };
  const doc = readFileSync("docs/design-system/tokens.md", "utf8");
  const rows = [...doc.matchAll(/^\| `--color-([a-z-]+)` \|(.*)\|$/gm)].map((m) => {
    const hexes = m[2]!.split("|").map((c) => c.trim()).filter((c) => /^#[0-9a-fA-F]{6}$/.test(c));
    return { name: m[1]!, light: hexes[0]?.toLowerCase(), dark: hexes[1]?.toLowerCase() };
  });

  it("表の色は、どれも globals.css にあり、値が同じ（明るい地・暗い地）", () => {
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) {
      expect(light[r.name], `${r.name}（明るい地）`).toBe(r.light);
      // モダリティの印を含め、どの行も暗い地の値を必須にする
      expect(r.dark, `${r.name}（表の暗い地）`).toBeDefined();
      expect(dark[r.name], `${r.name}（暗い地）`).toBe(r.dark);
    }
  });

  it("globals.css の色は、どれも表にある", () => {
    const named = new Set(rows.map((r) => r.name));
    expect(Object.keys(light).filter((n) => !named.has(n))).toEqual([]);
  });
});

/** CSS の `selector {` から最初の `}` までの塊から、`--<prefix>…` の宣言を名前と値（小文字）の対で返す */
function declarations(text: string, selector: string, prefix: RegExp): Record<string, string> {
  const plain = stripComments(text);
  const start = plain.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = plain.slice(start, plain.indexOf("}", start));
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)]
      .filter((d) => prefix.test(d[1]!))
      .map((d) => [d[1]!, d[2]!.trim().toLowerCase()]),
  );
}

// ui-kit の写し（3 製品で同じ値）。写しは直さず、globals.css をこれに合わせる。
// 文字の大きさ・余白・角は Tailwind の段（text-xs・p-3・rounded-md など）で書くので、ここでは比べない（docs/design-system/tokens.md の 2〜4）
describe("ui-kit の tokens.css と globals.css", () => {
  const kit = readFileSync("docs/design-system/ui-kit/tokens.css", "utf8");
  const COLOR = /^--color-/;
  const LAYOUT = /^--(?:w|h)-/;

  it("明るい地の色は、名前も値も同じ（足りない色も余分な色も無い）", () => {
    expect(declarations(css, "@theme", COLOR)).toEqual(declarations(kit, ":root", COLOR));
  });

  it("暗い地の色は、名前も値も同じ（globals.css の暗い地に無い色は明るい地の値を引き継ぐ）", () => {
    const dark = { ...declarations(css, "@theme", COLOR), ...declarations(css, '[data-theme="dark"]', COLOR) };
    expect(dark).toEqual(declarations(kit, ":root[data-theme=dark]", COLOR));
  });

  it("字体・外枠の高さ・本文の幅は同じ", () => {
    expect(declarations(css, "@theme", /^--font-/)).toEqual(declarations(kit, ":root", /^--font-/));
    const layout = declarations(css, ":root", LAYOUT);
    expect(Object.keys(layout).length).toBeGreaterThan(5);
    expect(layout).toEqual(declarations(kit, ":root", LAYOUT));
  });

  it("比べた変数は、比べた塊の外で定義し直さない（後ろの塊で上書きすると、画面の値が写しとずれる）", () => {
    const plain = stripComments(css);
    const all = /^--(?:color|font|w|h)-/;
    const blocks = [declarations(css, "@theme", all), declarations(css, '[data-theme="dark"]', all), declarations(css, ":root", all)];
    const names = new Set(blocks.flatMap((b) => Object.keys(b)));
    for (const name of names) {
      const defined = blocks.filter((b) => name in b).length;
      const count = [...plain.matchAll(new RegExp(`${name}\\s*:`, "g"))].length;
      expect(count, name).toBe(defined);
    }
    // 検査の目はある：後ろの塊の上書きを拾う
    const sample = `${css}\n:root { --w-login: 1px; }`;
    expect([...stripComments(sample).matchAll(/--w-login\s*:/g)].length).toBe(2);
  });

  it("写しの版は 1.0.0", () => {
    expect(readFileSync("docs/design-system/ui-kit/VERSION", "utf8").trim()).toBe("1.0.0");
  });
});

const badge = (kind: StatusKind, text: string) => createElement(StatusBadge, { kind, children: text });

describe("部品", () => {
  it("状態の札：どの種類も、文字と印（読み上げない）を持ち、色は枠と印に付く", () => {
    const kinds: StatusKind[] = ["planned", "active", "done", "canceled", "stopped", "sending", "confirmed", "failed", "unknown", "notice"];
    for (const kind of kinds) {
      const html = renderToStaticMarkup(badge(kind, "ラベル"));
      expect(html, kind).toContain("ラベル");
      expect(html, kind).toMatch(/<span aria-hidden="true" class="text-[a-z-]+">[^<]+<\/span>/);
      expect(html, kind).toContain(`data-kind="${kind}"`);
      expect(html, kind).not.toMatch(/bg-(?:danger|success|warning)/);
    }
  });

  it("状態の札：取消は文字に取り消し線を引かず（灰と「—」で示す）、結果不明は破線", () => {
    const canceled = renderToStaticMarkup(badge("canceled", "取消"));
    expect(canceled).not.toContain("line-through");
    expect(canceled).toContain("取消");
    expect(canceled).toContain("—");
    expect(renderToStaticMarkup(badge("unknown", "結果不明"))).toContain("border-dashed");
  });

  it("件数の行：補足が無くても、高さ（min-h-7）を持つ。補足は件数と別の区画に出す", () => {
    const without = renderToStaticMarkup(createElement(CountRow, null, "8 件"));
    expect(without).toContain("min-h-7");
    expect(without).not.toContain("text-label");
    const withAside = renderToStaticMarkup(createElement(CountRow, { aside: "自動更新（30秒）" }, "8 件"));
    expect(withAside).toMatch(/8 件<\/div><div[^>]*text-label[^>]*>自動更新（30秒）/);
  });

  it("患者バナー：氏名・かな・項目を並べ、値の無い項目は出さない。右端に札を置ける", () => {
    const html = renderToStaticMarkup(
      createElement(PatientBanner, {
        name: "試験 太郎",
        kana: "シケン タロウ",
        items: [
          { label: "患者 ID", value: "P000101", mono: true },
          { label: "受付番号", value: "" },
          { label: "検査日時", value: "2026/10/24 09:12" },
        ],
        end: badge("confirmed", "保管の確認 済"),
      }),
    );
    expect(html).toContain('aria-label="患者"');
    expect(html).toContain("試験 太郎");
    expect(html).toContain("シケン タロウ");
    expect(html).toContain("P000101");
    expect(html).not.toContain("受付番号");
    expect(html.indexOf("患者 ID")).toBeLessThan(html.indexOf("検査日時"));
    expect(html).toContain("保管の確認 済");
  });
});
