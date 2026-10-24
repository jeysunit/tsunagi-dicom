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
  // 押せる物の hover・押している間・選んだ行（docs/spec.md の 2.3）
  ["foreground", "hover"],
  ["label", "hover"],
  ["foreground", "pressed"],
  ["primary-foreground", "primary-active"],
  ["foreground", "selected"],
  ["value", "selected"],
  ["label", "selected"],
  // 地の濃淡で面を分ける段（muted・muted-strong）と、その上のリンク・誤りの文字
  ["foreground", "muted-strong"],
  ["label", "muted-strong"],
  ["link", "muted"],
  ["link", "muted-strong"],
  ["link", "selected"],
  ["danger", "selected"],
  // 終わったことの印の文字（送信完了・接続確認の成功）
  ["success", "background"],
  ["success", "surface"],
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

describe("押せる物の hover と選んだ行は、地と見分けられる（docs/spec.md の 2.3）", () => {
  for (const [name, set] of [
    ["明るい地", light],
    ["暗い地", dark],
  ] as const) {
    // 前の hover（muted）は、白い地との差が 1.12:1 で、ほぼ見えなかった
    it(`${name}：hover の地は、地と控えめな地のどちらとも 1.2:1 以上の差`, () => {
      expect(contrast(set.hover!, set.background!)).toBeGreaterThanOrEqual(1.2);
      expect(contrast(set.hover!, set.surface!)).toBeGreaterThanOrEqual(1.15);
    });
    it(`${name}：押している間の地は hover の地より濃い（明るい地）・明るい（暗い地）`, () => {
      expect(contrast(set.pressed!, set.background!)).toBeGreaterThan(contrast(set.hover!, set.background!));
      expect(contrast(set["primary-active"]!, set.background!)).not.toBe(contrast(set["primary-hover"]!, set.background!));
    });
    it(`${name}：選んだ行の地は、行の hover の地（muted）と違う`, () => {
      expect(set.selected).not.toBe(set.muted);
      expect(contrast(set.selected!, set.background!)).toBeGreaterThan(1.05);
    });
  }
});

describe("入力欄・ボタンの輪郭（border-input）は、地との対比が 3:1 以上（WCAG 2.2 の 1.4.11）", () => {
  for (const [name, set] of [
    ["明るい地", light],
    ["暗い地", dark],
  ] as const) {
    it.each(["background", "surface"])(`${name}：border-input と %s の地`, (bg) => {
      expect(contrast(set["border-input"]!, set[bg]!)).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("グレーは色味のない中立（R=G=B）", () => {
  for (const [name, set] of [
    ["明るい地", light],
    ["暗い地", dark],
  ] as const) {
    it.each(["background", "surface", "foreground", "label", "value", "border", "border-input", "muted", "muted-strong", "hover", "pressed", "chrome"])(`${name}：%s`, (key) => {
      const hex = set[key]!;
      expect(hex.slice(1, 3), key).toBe(hex.slice(3, 5));
      expect(hex.slice(3, 5), key).toBe(hex.slice(5, 7));
    });
  }
});

describe("spec の 2 の色の値", () => {
  it("明るい地", () => {
    expect(light).toMatchObject({
      background: "#ffffff",
      surface: "#f6f6f6",
      foreground: "#262626",
      label: "#5f5f5f",
      value: "#1a1a1a",
      border: "#d2d2d2",
      "border-input": "#8c8c8c",
      muted: "#eeeeee",
      "muted-strong": "#e2e2e2",
      chrome: "#333333",
      primary: "#4b4fbf",
      "primary-foreground": "#ffffff",
      "primary-hover": "#3b3ea3",
      link: "#4b4fbf",
    });
  });

  it("暗い地", () => {
    expect(dark).toMatchObject({
      background: "#1b1b1b",
      surface: "#242424",
      foreground: "#e8e8e8",
      label: "#a3a3a3",
      value: "#ffffff",
      border: "#3a3a3a",
      "border-input": "#777777",
      muted: "#2d2d2d",
      "muted-strong": "#383838",
      chrome: "#121212",
      primary: "#4b4fbf",
      "primary-foreground": "#ffffff",
      "primary-hover": "#3b3ea3",
      link: "#a5a8ff",
    });
  });

  it("状態の色（誤り・終わったこと）は、主の色とは別の枠で、前の値のまま", () => {
    expect(light).toMatchObject({ danger: "#d1242f", success: "#1a7f37" });
    expect(dark).toMatchObject({ danger: "#ff7b72", success: "#3fb950" });
  });

  it("前の主の色（#2f81f7 に白い字。対比が足りない）と、前の青の値を使っていない", () => {
    const lower = css.toLowerCase();
    for (const old of ["#2f81f7", "#0757b5", "#054a9b", "#f6f8fa", "#d1d9e0", "#1f6feb"]) expect(lower, old).not.toContain(old);
  });
});
