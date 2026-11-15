import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// ブラウザのタブのアイコン（docs/design-system/components.md の「頁の題とアイコン」。形と色の値は案）。
// 四角の色はトークンの値だけ：明るい地は primary、暗い地は link の暗い地の値。絵の線は白（暗い地は #1b1b1b）。

const svg = readFileSync("src/app/icon.svg", "utf8");
const css = readFileSync("src/app/globals.css", "utf8");

/** globals.css の暗い地のブロックにあるトークンの値 */
function darkToken(name: string): string {
  const dark = css.slice(css.indexOf("prefers-color-scheme: dark") >= 0 ? css.indexOf("prefers-color-scheme: dark") : css.indexOf('[data-theme="dark"]'));
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(dark);
  return (m?.[1] ?? "").toLowerCase();
}

function lightToken(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  return (m?.[1] ?? "").toLowerCase();
}

describe("タブのアイコン", () => {
  it("16×16 の角丸（角 3px）の四角に、線の幅 1.6px の 2 つの輪", () => {
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toMatch(/<rect[^>]*width="16"[^>]*height="16"[^>]*rx="3"/);
    expect(svg.match(/<circle/g)).toHaveLength(2);
    expect(svg).toContain("stroke-width: 1.6");
    expect(svg).toMatch(/cx="6\.2" cy="8" r="3\.2"/);
    expect(svg).toMatch(/cx="9\.8" cy="8" r="3\.2"/);
  });

  it("四角の色はトークンの値（明るい地は primary、暗い地は link の暗い地の値）", () => {
    const light = /\.box\s*\{\s*fill:\s*(#[0-9a-fA-F]{6})/.exec(svg)?.[1]?.toLowerCase();
    expect(light).toBe(lightToken("primary"));
    const dark = /prefers-color-scheme: dark\)\s*\{\s*\.box\s*\{\s*fill:\s*(#[0-9a-fA-F]{6})/.exec(svg)?.[1]?.toLowerCase();
    expect(dark).toBe(darkToken("link"));
  });

  it("絵の線は、明るい地では白、暗い地では #1b1b1b", () => {
    expect(svg).toMatch(/\.mark\s*\{[^}]*stroke:\s*#ffffff/);
    expect(svg).toMatch(/prefers-color-scheme: dark\)[\s\S]*\.mark\s*\{\s*stroke:\s*#1b1b1b/);
  });
});
