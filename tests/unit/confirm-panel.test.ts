import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConfirmActions, ConfirmPanel } from "@/components/ui/confirm-panel";
import { ReauthForm } from "@/components/ui/reauth-form";

// 確かめの欄と再認証の欄（docs/design-system/parts.md の「確かめの使い分け」）の形を、サーバーの側で描いて確かめる。
// フォーカスとスクロールはブラウザの動きなので、e2e（tests/e2e/local-auth.spec.ts）で見る。

const noop = () => undefined;

describe("ConfirmPanel", () => {
  it("対象の要約は 氏名・患者ID・生年月日と性別 の 3 つで、無い値は「—」", () => {
    const html = renderToString(
      createElement(ConfirmPanel, {
        label: "検査の削除",
        confirmTestId: "box",
        summary: { name: "試験 太郎", patientId: "JP-0001", birthLine: "" },
      }),
    );
    expect(html).toContain("試験 太郎");
    expect(html).toContain("JP-0001");
    expect(html).toMatch(/data-testid="confirm-birth"[^>]*>—</);
    expect(html.match(/<dt/g)).toHaveLength(3);
    expect(html).toContain('data-testid="box"');
  });

  it("取り消せない操作（danger）の枠は danger の色、ふつうは border の色", () => {
    expect(renderToString(createElement(ConfirmPanel, { label: "a", tone: "danger" }))).toContain("border-danger");
    expect(renderToString(createElement(ConfirmPanel, { label: "a" }))).not.toContain("border-danger");
  });

  it("要約・詳細・戻せるかが無ければ、包む要素を出さない", () => {
    const html = renderToString(createElement(ConfirmPanel, { label: "a", confirmTestId: "box" }));
    expect(html).not.toContain('data-testid="box"');
  });
});

describe("ConfirmActions", () => {
  it("キャンセルが左、実行が右。実行を外すとキャンセル（閉じる）だけになる", () => {
    const both = renderToString(createElement(ConfirmActions, { confirmLabel: "削除する", onCancel: noop }));
    expect(both.indexOf("キャンセル")).toBeGreaterThan(-1);
    expect(both.indexOf("キャンセル")).toBeLessThan(both.indexOf("削除する"));
    const closeOnly = renderToString(createElement(ConfirmActions, { confirmLabel: "削除する", hideConfirm: true, cancelLabel: "閉じる", onCancel: noop }));
    expect(closeOnly).toContain("閉じる");
    expect(closeOnly).not.toContain("削除する");
  });

  it("onConfirm が無ければ submit（form の中）、あれば button", () => {
    expect(renderToString(createElement(ConfirmActions, { confirmLabel: "実行", onCancel: noop }))).toContain('type="submit"');
    expect(renderToString(createElement(ConfirmActions, { confirmLabel: "実行", onConfirm: noop, onCancel: noop }))).not.toContain('type="submit"');
  });

  it("実行は、押せない条件（confirmDisabled）と待ち（pending）で押せなくなる", () => {
    expect(renderToString(createElement(ConfirmActions, { confirmLabel: "実行", confirmDisabled: true, onCancel: noop }))).toMatch(/<button[^>]*disabled=""[^>]*>[^<]*実行/);
    expect(renderToString(createElement(ConfirmActions, { confirmLabel: "実行", pending: true, onCancel: noop }))).toContain('aria-busy="true"');
  });
});

describe("ReauthForm", () => {
  it("パスワードの欄は password と名前を持ち、既定では認証コードの欄を出さない", () => {
    const html = renderToString(createElement(ReauthForm, { submitLabel: "認証", onSubmit: noop }));
    expect(html).toContain('name="password"');
    expect(html).toContain('type="password"');
    expect(html).toContain("current-password");
    expect(html).not.toContain('name="code"');
  });

  it("needsCode で認証コードの欄を足し、誤りは alert の 1 行に出す", () => {
    const html = renderToString(createElement(ReauthForm, { submitLabel: "認証", needsCode: true, error: "パスワードが違います", onSubmit: noop }));
    expect(html).toContain('name="code"');
    expect(html).toMatch(/role="alert"[^>]*>パスワードが違います/);
  });

  it("欄の名前を、目に見える文字（visibleLabels）か aria-label のどちらかで持つ", () => {
    const visible = renderToString(createElement(ReauthForm, { submitLabel: "認証", visibleLabels: true, onSubmit: noop }));
    expect(visible).toContain("<span");
    expect(visible).not.toContain('aria-label="パスワード"');
    const hidden = renderToString(createElement(ReauthForm, { submitLabel: "認証", onSubmit: noop }));
    expect(hidden).toContain('aria-label="パスワード"');
  });
});
