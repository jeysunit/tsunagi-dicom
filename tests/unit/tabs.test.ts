import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tabs } from "@/components/ui/tabs";

// タブ（docs/design-system/components.md の「タブ・手順」）：最初のタブが選ばれ、選ばれていないタブの中身も描いて見えなくする。

const items = [
  { id: "a", label: "シリーズ", content: createElement("p", null, "シリーズの中身") },
  { id: "b", label: "検査の情報", content: createElement("p", null, "検査の情報の中身") },
];

describe("タブ", () => {
  const html = renderToStaticMarkup(createElement(Tabs, { items, label: "検査の内容" }));

  it("tablist に名前が付き、最初のタブだけが選ばれてフォーカスを受ける", () => {
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="検査の内容"');
    const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toContain('aria-selected="true"');
    expect(tabs[0]).toContain('tabindex="0"');
    expect(tabs[1]).toContain('aria-selected="false"');
    expect(tabs[1]).toContain('tabindex="-1"');
  });

  it("読むだけのパネル（readOnly）は、見えている間だけフォーカスを受ける。押せる物のあるパネルには足さない", () => {
    const readOnly = [items[0]!, { ...items[1]!, readOnly: true }];
    const panelsOf = (h: string) => [...h.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);
    // 最初のタブ（押せる物のあるパネル）が見えている間：どちらのパネルにも tabindex は無い
    for (const p of panelsOf(renderToStaticMarkup(createElement(Tabs, { items: readOnly, label: "検査の内容" })))) expect(p).not.toContain("tabindex");
    // 読むだけのパネルが最初に見えている間は、そのパネルだけが tabindex="0"
    const first = renderToStaticMarkup(createElement(Tabs, { items: [{ ...items[0]!, readOnly: true }, items[1]!], label: "検査の内容" }));
    const [a, b] = panelsOf(first);
    expect(a).toContain('tabindex="0"');
    expect(b).not.toContain("tabindex");
  });

  it("選ばれていないタブの中身も描き、hidden にする（中の状態を失わない）。タブと中身は aria-controls・aria-labelledby で結ぶ", () => {
    const panels = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);
    expect(panels).toHaveLength(2);
    expect(panels[0]).not.toContain("hidden");
    expect(panels[1]).toContain("hidden");
    expect(html).toContain("検査の情報の中身");
    const tabControls = [...html.matchAll(/role="tab"[^>]*aria-controls="([^"]+)"/g)].map((m) => m[1]);
    for (const id of tabControls) expect(html).toContain(`id="${id}"`);
  });
});
