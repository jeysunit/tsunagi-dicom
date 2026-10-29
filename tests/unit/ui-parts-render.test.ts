import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { checkSummary, ConnStatus, OverallBadge, type Overall } from "@/components/layout/conn-status";
import { NavToggle } from "@/components/layout/nav-toggle";
import { Button } from "@/components/ui/button";
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
  it("標準の popover 属性で開く：ボタンは popovertarget、中身は popover。自前の開け閉めを書かない", () => {
    const html = renderToStaticMarkup(createElement(ConnStatus, { timeZone: "Asia/Tokyo" }));
    // HTML の属性名は大文字小文字を区別しない（React の描画は popoverTarget と書く）
    expect(html).toMatch(/<button[^>]*popovertarget="conn-pop"/i);
    expect(html).toMatch(/<div[^>]*id="conn-pop"[^>]*popover="auto"/);
    // 中身は接続先の頁への道を持つ
    expect(html).toContain('href="/modalities"');
    expect(html).toContain("接続先を開く");
  });

  // 上の帯の構造（parts.md の「上の帯」。C3）：枠つき 32px のボタンの中に 「接続の状態」・札・シェブロンをこの順で置く
  it("ボタンは 32px の枠つき。「接続の状態」・全体の札・シェブロン（絵）の順で、aria-label は付けない", () => {
    const html = renderToStaticMarkup(createElement(ConnStatus, { timeZone: "Asia/Tokyo" }));
    const button = /<button\b[^>]*>(.*?)<\/button>/.exec(html);
    expect(button).not.toBeNull();
    const open = /<button\b[^>]*>/.exec(html)![0];
    const classes = /class="([^"]*)"/.exec(open)![1]!.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["h-8", "border", "border-border-input", "rounded", "px-2"]));
    expect(open).not.toContain("aria-label");
    expect(open).toContain('aria-expanded="false"');
    const inner = button![1]!;
    const at = (needle: string) => inner.indexOf(needle);
    expect(at("接続の状態")).toBeGreaterThanOrEqual(0);
    expect(at("接続の状態")).toBeLessThan(at('data-slot="status-badge"'));
    expect(at('data-slot="status-badge"')).toBeLessThan(at("<svg"));
    // 640px 未満は文字だけ視覚的に隠す（名前は残る）。シェブロンは読み上げない
    expect(inner).toMatch(/<span class="max-sm:sr-only">接続の状態<\/span>/);
    expect(inner).toMatch(/<svg[^>]*aria-hidden="true"/);
  });

  it("popover に「接続確認」のボタンと、結果だけを読み上げる領域（role=status・aria-live=polite）を置く。権限が無ければボタンは出さない", () => {
    const withCheck = renderToStaticMarkup(createElement(ConnStatus, { timeZone: "Asia/Tokyo", canCheck: true }));
    expect(withCheck).toMatch(/<button[^>]*data-testid="conn-check"[^>]*>接続確認<\/button>/);
    expect(withCheck).toMatch(/<p class="sr-only" role="status" aria-live="polite"[^>]*><\/p>/);
    // 札のあるボタンの側には aria-live を付けない（1 分ごとに替わる札は読み上げない）
    expect(/<button\b[^>]*popovertarget[^>]*>/i.exec(withCheck)![0]).not.toContain("aria-live");
    const without = renderToStaticMarkup(createElement(ConnStatus, { timeZone: "Asia/Tokyo" }));
    expect(without).not.toContain("接続確認</button>");
  });

  it("接続確認の結果の文は parts.md の 3 つの型だけ", () => {
    const ok = { ok: true, data: { connected: true } };
    const ng = { ok: true, data: { connected: false } };
    const unreadable = { ok: false, data: { error: "権限がありません" } };
    expect(checkSummary([ok, ok, ok])).toBe("3 件すべてに接続できました。");
    expect(checkSummary([ok, ng, unreadable])).toBe("3 件のうち 2 件に接続できませんでした。");
    expect(checkSummary([ng, ng])).toBe("2 件のうち 2 件に接続できませんでした。");
    // 全部が読めなかった（要求が届かない・権限・期限切れ）ときと、確かめる相手が無いときは「確かめられなかった」
    expect(checkSummary([unreadable, unreadable])).toBe("接続を確かめられませんでした。");
    expect(checkSummary([])).toBe("接続を確かめられませんでした。");
  });

  it("全体の状態の語は 5 つだけで、data-k は parts.md の表のとおり", () => {
    const words: [Overall, string, string][] = [
      ["loading", "確認中", "check"],
      ["ok", "接続中", "ok"],
      ["ng", "一部が接続不可", "ng"],
      ["unchecked", "未確認", "plan"],
      ["unknown", "確認できません", "unknown"],
    ];
    for (const [overall, word, k] of words) {
      const html = renderToStaticMarkup(createElement(OverallBadge, { overall }));
      expect(html, overall).toContain(`data-k="${k}"`);
      expect(html, overall).toContain(`>${word}</span>`);
    }
  });

});

// 部品集の値（ui-kit 1.2.2 の .btn・.empty・.notice）。クラスの名前で見る
const classesOf = (html: string) => new Set(/class="([^"]*)"/.exec(html)![1]!.split(/\s+/));

describe("ボタン（Button）", () => {
  it("標準は高さ 32px・角 4px・影なし。小は 28px", () => {
    const base = classesOf(renderToStaticMarkup(createElement(Button, { variant: "outline" }, "副")));
    for (const c of ["h-8", "min-w-16", "px-3", "rounded", "border", "border-border-input", "bg-background"]) expect(base.has(c), c).toBe(true);
    expect([...base].some((c) => /^shadow/.test(c))).toBe(false);
    const sm = classesOf(renderToStaticMarkup(createElement(Button, { size: "sm" }, "小")));
    expect(sm.has("h-7")).toBe(true);
    expect(sm.has("min-w-12")).toBe(true);
  });

  it("主は太字（副は太字にしない）。押せないときは地 surface・字 label・枠 border・太字にしない", () => {
    const primary = classesOf(renderToStaticMarkup(createElement(Button, null, "主")));
    expect(primary.has("font-bold")).toBe(true);
    expect(primary.has("bg-primary")).toBe(true);
    const outline = classesOf(renderToStaticMarkup(createElement(Button, { variant: "outline" }, "副")));
    expect(outline.has("font-bold")).toBe(false);
    for (const c of ["disabled:bg-surface", "disabled:text-label", "disabled:border-border", "disabled:font-normal"]) expect(primary.has(c), c).toBe(true);
    expect([...primary].some((c) => c.startsWith("disabled:opacity"))).toBe(false);
  });
});

describe("空の状態・知らせの外枠", () => {
  it("空の状態は中央寄せの点線の枠（権限の無い頁だけ実線）", () => {
    const empty = classesOf(renderToStaticMarkup(createElement(EmptyState, { fact: "条件に合う検査はありません。" })));
    for (const c of ["items-center", "text-center", "border", "border-dashed", "border-border-input", "rounded-md", "py-8", "px-4", "text-label"]) expect(empty.has(c), c).toBe(true);
    const denied = renderToStaticMarkup(createElement(EmptyState, { kind: "denied" }));
    expect(denied).toContain('data-kind="denied"');
    expect(classesOf(denied).has("data-[kind=denied]:border-solid")).toBe(true);
  });

  it("知らせは枠 1px に左だけ 4px、角 4px。info の線は border-input", () => {
    const ok = classesOf(renderToStaticMarkup(createElement(Notice, { kind: "ok", children: "x" })));
    for (const c of ["border", "border-l-4", "border-border", "rounded", "border-l-success"]) expect(ok.has(c), c).toBe(true);
    const info = renderToStaticMarkup(createElement(Notice, { kind: "info", children: "x" }));
    expect(info).toContain('data-k="info"');
    expect(classesOf(info).has("border-l-border-input")).toBe(true);
  });
});

describe("ナビの開閉（NavToggle）", () => {
  it("絵は Menu で固定し、名前は「ナビを開閉する」で固定。aria-expanded・aria-controls=sidenav・32px。title だけ替える", () => {
    const html = renderToStaticMarkup(createElement(NavToggle));
    expect(html).toContain('aria-label="ナビを開閉する"');
    expect(html).toContain('aria-controls="sidenav"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('title="ナビを閉じる"');
    expect(html).toMatch(/class="[^"]*\bh-8\b[^"]*\bmin-w-8\b/);
    // Lucide の menu は 3 本線（path ではなく、横線 3 本）。開いても閉じても同じ絵（閉じる側の絵 panel-left は使わない）
    expect(html).toContain("lucide-menu");
    expect(html).not.toContain("lucide-panel-left");
  });
});
