import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnStatus } from "@/components/layout/conn-status";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";

// 部品の構造（docs/design-system/parts.md）：知らせの読み上げの役割、見出しの行、空の状態の denied の文、選択欄の高さと枠、
// 上の帯の接続の状態が標準の popover 属性で開くこと。サーバーの側で描いた HTML を見る。

describe("知らせ（Notice）", () => {
  it("画面の上の誤りだけ role=alert。ほかは role=status。入力欄の下の誤りには使わない", () => {
    expect(renderToStaticMarkup(createElement(Notice, { kind: "err", alert: true, children: "送信できませんでした。" }))).toContain('role="alert"');
    // err でも alert を付けなければ status（読み上げを増やさない）
    expect(renderToStaticMarkup(createElement(Notice, { kind: "err", children: "x" }))).toContain('role="status"');
    // alert を付けても、誤り以外は alert にしない
    for (const kind of ["ok", "warn", "info"] as const) {
      expect(renderToStaticMarkup(createElement(Notice, { kind, alert: true, children: "x" }))).toContain('role="status"');
    }
  });

  it("状態の色の線（左 4px）に加えて、印（絵）と文を持つ。色だけで伝えない", () => {
    const html = renderToStaticMarkup(createElement(Notice, { kind: "ok", children: "試験 太郎（P000101）を送信しました。" }));
    expect(html).toContain("border-l-4");
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("試験 太郎（P000101）を送信しました。");
  });
});

describe("見出しの行（PageHeader）", () => {
  it("h1 は頁の名前だけ。補足は small に入れ、操作は右に置く", () => {
    const html = renderToStaticMarkup(createElement(PageHeader, { title: "検査一覧", note: "2026/10/25", actions: createElement("button", null, "操作") }));
    expect(html).toMatch(/<h1[^>]*>検査一覧<small[^>]*>2026\/10\/25<\/small><\/h1>/);
    expect(html).toContain("<button>操作</button>");
    expect(renderToStaticMarkup(createElement(PageHeader, { title: "接続先" }))).not.toContain("<small");
  });
});

describe("空の状態（EmptyState）", () => {
  it("1 行目は事実、2 行目は次の手、操作は 1 つ", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { fact: "条件に合う検査はありません。", next: "条件を変えてください。", action: createElement("button", null, "条件をクリア") }),
    );
    expect(html.indexOf("条件に合う検査はありません。")).toBeLessThan(html.indexOf("条件を変えてください。"));
    expect(html).toContain("<button>条件をクリア</button>");
  });

  it("denied は、事実・次の手・検査一覧への道の 3 つ。黙って移さない", () => {
    const admin = renderToStaticMarkup(createElement(EmptyState, { kind: "denied" }));
    expect(admin).toContain("この画面は管理者のみ利用できます。");
    expect(admin).toContain('role="status"');
    expect(admin).toContain("管理者に役割の変更を頼んでください。");
    expect(admin).toMatch(/<a[^>]*href="\/"[^>]*>検査一覧へ<\/a>/);
    const other = renderToStaticMarkup(createElement(EmptyState, { kind: "denied", adminOnly: false }));
    expect(other).toContain("この画面を開く権限がありません。");
    expect(other).not.toContain("管理者のみ利用できます");
  });
});

describe("選択欄（Select）", () => {
  it("高さは default 32px・sm 28px、枠は border-input", () => {
    const base = renderToStaticMarkup(createElement(Select, null, createElement("option", null, "a")));
    expect(base).toContain("h-8");
    expect(base).toContain("border-border-input");
    const sm = renderToStaticMarkup(createElement(Select, { size: "sm" }, createElement("option", null, "a")));
    expect(sm).toContain("h-7");
    expect(sm).not.toContain("h-8");
  });
});

describe("接続の状態（ConnStatus）", () => {
  it("標準の popover 属性で開く：ボタンは popovertarget、中身は popover。自前の開閉の属性（aria-expanded の固定など）を持たない", () => {
    const html = renderToStaticMarkup(createElement(ConnStatus, { timeZone: "Asia/Tokyo" }));
    // HTML の属性名は大文字小文字を区別しない（React の描画は popoverTarget と書く）
    expect(html).toMatch(/<button[^>]*popovertarget="conn-pop"/i);
    expect(html).toMatch(/<div[^>]*id="conn-pop"[^>]*popover="auto"/);
    expect(html).not.toContain("aria-expanded");
    // 中身は接続先の頁への道を持つ
    expect(html).toContain('href="/modalities"');
    expect(html).toContain("接続先を開く");
  });
});
