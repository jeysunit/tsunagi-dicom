import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ModalityMark } from "@/components/ui/modality-mark";
import {
  CellMain,
  CellSub,
  rowKeyAction,
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// 一覧の表（docs/design-system/parts.md の「一覧の表（`.tbl`）」）の決まりを、部品の出す HTML で確かめる。
// 押した・キーの振る舞いのうち、部品の外から決まる部分（キーの意味）は rowKeyAction で確かめる。

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

const row = (props: Parameters<typeof TableRow>[0]) =>
  html(
    createElement(
      "table",
      null,
      createElement("tbody", null, createElement(TableRow, props, createElement(TableCell, null, "2026/10/25"))),
    ),
  );

describe("一覧の表（ui/table）", () => {
  it("包み：表の中をスクロールさせ、名前を渡すと読み上げの区画になり、キーボードで止まる", () => {
    const out = html(createElement(Table, { label: "検査の一覧" }, createElement(TableBody, null)));
    expect(out).toMatch(/<div[^>]*class="tbl-wrap[^"]*overflow-auto/);
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-label="検査の一覧"');
    expect(out).toContain('tabindex="0"');
    // 名前を渡さない表は区画にしない
    expect(html(createElement(Table, null, createElement(TableBody, null)))).not.toContain("role=");
  });

  it("見出しの行：28px・地 surface・表の中のスクロールでも上に残る（sticky top-0）", () => {
    const out = html(
      createElement(
        "table",
        null,
        createElement(TableHeader, null, createElement("tr", null, createElement(TableHead, null, "検査日時"))),
      ),
    );
    expect(out).toMatch(/<thead[^>]*class="[^"]*\bsticky\b[^"]*\btop-0\b[^"]*\bbg-surface\b/);
    expect(out).toMatch(/<th[^>]*class="[^"]*\bh-7\b[^"]*\btext-xs\b/);
  });

  it("並べ替えの見出し：いまの列は aria-sort と太字、ほかの列は aria-sort を付けない。見出しは押せるボタン", () => {
    const sorted = html(
      createElement("table", null, createElement("thead", null, createElement("tr", null, createElement(SortableHead, { sort: "desc", onSort: () => undefined }, "検査日時")))),
    );
    expect(sorted).toContain('aria-sort="descending"');
    expect(sorted).toMatch(/<button type="button"[^>]*font-bold/);
    const other = html(
      createElement("table", null, createElement("thead", null, createElement("tr", null, createElement(SortableHead, { sort: undefined, onSort: () => undefined }, "患者ID")))),
    );
    expect(other).not.toContain("aria-sort");
    expect(other).not.toContain("font-bold");
  });

  it("行：28px。2 行の氏名・ボタンのある行（tall）は 40px", () => {
    expect(row({})).toMatch(/<tr[^>]*class="[^"]*\bh-7\b/);
    expect(row({ tall: true })).toMatch(/<tr[^>]*class="[^"]*\bh-10\b/);
  });

  it("選べる行：tabindex と aria-selected を持つ。選んだ行は地 selected-strong と最初のセルの左 3px の線で、太字にしない", () => {
    const picked = row({ selected: true, onSelect: () => undefined });
    expect(picked).toContain('aria-selected="true"');
    expect(picked).toContain('tabindex="0"');
    expect(picked).toContain("bg-selected-strong");
    expect(picked).toContain("[&amp;&gt;td:first-child]:shadow-[inset_3px_0_0_var(--color-ring)]");
    expect(picked).not.toContain("font-bold");
    // hover の地は選んだ行に当てない
    expect(picked).not.toContain("hover:bg-muted");

    const other = row({ selected: false, onSelect: () => undefined });
    expect(other).toContain('aria-selected="false"');
    expect(other).toContain("hover:bg-muted");
    expect(other).not.toContain("bg-selected-strong");
  });

  it("選べない行：aria-selected も tabindex も付けない", () => {
    const plain = row({});
    expect(plain).not.toContain("aria-selected");
    expect(plain).not.toContain("tabindex");
  });

  it("ローヴィングの止まり先：渡した tabindex（-1）を使う", () => {
    expect(row({ onSelect: () => undefined, tabIndex: -1 })).toContain('tabindex="-1"');
  });

  it("キー：Space は選ぶ。Enter は開く操作のある表では開き、無い表では選ぶ。ほかのキーは扱わない", () => {
    expect(rowKeyAction(" ", false)).toBe("select");
    expect(rowKeyAction(" ", true)).toBe("select");
    expect(rowKeyAction("Enter", false)).toBe("select");
    expect(rowKeyAction("Enter", true)).toBe("open");
    expect(rowKeyAction("Escape", true)).toBeNull();
    expect(rowKeyAction("ArrowDown", false)).toBeNull();
  });

  it("セル：名前は太字（main-c）、補足は 12px の label（sub）、数は右寄せ（num）", () => {
    expect(html(createElement(CellMain, null, "試験 太郎"))).toMatch(/class="main-c font-bold text-value"/);
    expect(html(createElement(CellSub, null, "ロック中"))).toMatch(/class="sub block text-xs text-label"/);
    const num = html(createElement("table", null, createElement("tbody", null, createElement("tr", null, createElement(TableCell, { num: true }, "412")))));
    expect(num).toMatch(/class="[^"]*\bnum\b[^"]*\btext-right\b[^"]*\btabular-nums\b/);
  });
});

describe("モダリティの印（ui/modality-mark）", () => {
  it("左 4px の色の線・地 surface・12px 太字の 1 つの形。丸の点は使わない", () => {
    const ct = html(createElement(ModalityMark, { modality: "CT" }));
    expect(ct).toContain("CT");
    expect(ct).toMatch(/class="mod [^"]*\bborder-l-4\b[^"]*\bbg-surface\b[^"]*\btext-xs\b[^"]*\bfont-bold\b/);
    expect(ct).toContain("border-l-mod-ct");
    expect(ct).not.toContain("rounded-full");
  });

  it("群ごとの色の線。群に入らないモダリティは label の灰", () => {
    expect(html(createElement(ModalityMark, { modality: "MR" }))).toContain("border-l-mod-mr");
    expect(html(createElement(ModalityMark, { modality: "DX" }))).toContain("border-l-mod-crdx");
    expect(html(createElement(ModalityMark, { modality: "XA" }))).toContain("border-l-label");
  });
});
