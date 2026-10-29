import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChevronDown, Menu } from "lucide-react";
import { describe, expect, it } from "vitest";

// 部品集（ui-kit）の写しを守る検査（部品集 system/delivery.md の 4 の C1）。
// 写しは製品の側で直さない。指紋（SHA256SUMS）と一致しなければ、写しが手で直されたか、写し直しが不完全。
// tsunagi は components.css を読まないので、写さない（部品の値は docs/design-system/parts.md に合わせる）。

const KIT = "docs/design-system/ui-kit";
const COPIED = ["tokens.css", "icons.svg", "VERSION"] as const;

const sums = new Map(
  readFileSync(`${KIT}/SHA256SUMS`, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
      expect(m, `SHA256SUMS の形：${line}`).not.toBeNull();
      return [m![2]!, m![1]!] as const;
    }),
);

describe("ui-kit の写し", () => {
  it.each(COPIED)("%s の指紋が SHA256SUMS と一致する", (name) => {
    const digest = createHash("sha256").update(readFileSync(`${KIT}/${name}`)).digest("hex");
    expect(sums.get(name), `SHA256SUMS に ${name} の行が無い`).toBeDefined();
    expect(digest).toBe(sums.get(name));
  });

  it("写しの版は 1.2.2", () => {
    expect(readFileSync(`${KIT}/VERSION`, "utf8").trim()).toBe("1.2.2");
  });

  // 上の帯で使う絵（ナビの開閉・接続の状態のシェブロン）は、lucide-react の同じ名前の絵をそのまま使う。
  // 部品集の絵の表は Lucide 1.59.0 の path を書く。lucide-react の版が上がって絵が変わったら、ここが落ちる
  it.each([
    ["i-menu", Menu],
    ["i-chevd", ChevronDown],
  ] as const)("%s の path は lucide-react の同じ名前の絵と同じ", (id, Icon) => {
    const svg = readFileSync(`${KIT}/icons.svg`, "utf8");
    const symbol = new RegExp(`<symbol id="${id}"[^>]*>(.*?)</symbol>`, "s").exec(svg)?.[1];
    expect(symbol, id).toBeDefined();
    const shapes = (s: string) => [...s.matchAll(/<(path|circle|line|rect)\b([^>]*?)\/?>/g)].map((m) => `${m[1]}${m[2]!.replace(/\s+/g, " ").trim()}`);
    const rendered = renderToStaticMarkup(createElement(Icon));
    expect(shapes(rendered)).toEqual(shapes(symbol!));
  });
});
