import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 設計の値（src/app/globals.css）の、文字と地の対比（WCAG 2.2 の AA：4.5:1 以上）と、spec の 2 の色の値。

const css = readFileSync("src/app/globals.css", "utf8");

/** CSS の1つの塊（`@theme { … }` や `[data-theme="dark"] { … }`）の `--color-*` の値 */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const light = tokens("@theme");
const dark = { ...light, ...tokens('[data-theme="dark"]') };

/** 文字の色と、その文字が乗る地 */
const PAIRS: [string, string][] = [
  ["foreground", "background"],
  ["foreground", "surface"],
  ["label", "background"],
  ["label", "surface"],
  ["value", "background"],
  ["value", "surface"],
  ["link", "background"],
  ["link", "surface"],
  ["danger", "background"],
  ["danger", "surface"],
  ["primary-foreground", "primary"],
  ["primary-foreground", "primary-hover"],
  ["label", "muted"],
  ["foreground", "muted"],
  ["dev-band-foreground", "dev-band"],
];

describe("文字と地の対比（WCAG 2.2 の AA）", () => {
  for (const [name, set] of [
    ["明るい地", light],
    ["暗い地", dark],
  ] as const) {
    it.each(PAIRS)(`${name}：%s の字と %s の地は 4.5:1 以上`, (fg, bg) => {
      expect(set[fg], fg).toBeDefined();
      expect(set[bg], bg).toBeDefined();
      expect(contrast(set[fg]!, set[bg]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("spec の 2 の色の値", () => {
  it("明るい地", () => {
    expect(light).toMatchObject({
      background: "#ffffff",
      surface: "#f6f8fa",
      foreground: "#1f2328",
      label: "#59636e",
      value: "#1f2328",
      border: "#d1d9e0",
      primary: "#0969da",
      "primary-foreground": "#ffffff",
    });
  });

  it("暗い地", () => {
    expect(dark).toMatchObject({
      background: "#121417",
      surface: "#1a1d21",
      foreground: "#e6edf3",
      label: "#8a949e",
      value: "#ffffff",
      primary: "#1f6feb",
      "primary-foreground": "#ffffff",
    });
  });

  it("前の主の色（#2f81f7 に白い字。対比が足りない）を使っていない", () => {
    expect(css.toLowerCase()).not.toContain("#2f81f7");
  });
});
