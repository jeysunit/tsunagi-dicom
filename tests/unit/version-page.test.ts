import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// 「バージョン情報」の頁（docs/spec.md の 2.3）：BUILD_COMMIT を渡したとき、ビルドの行に commit を全桁・等幅（13px）で出す。
// e2e のサーバーは BUILD_COMMIT を渡さずに起動するので、頁をサーバーの側で描いて確かめる。

vi.mock("@/lib/auth/page-session", () => ({
  pageAccess: async () => ({ kind: "ok", session: {} }),
}));

async function render(): Promise<string> {
  const { default: VersionPage } = await import("@/app/version/page");
  return renderToStaticMarkup(createElement("div", null, await VersionPage()));
}

afterEach(() => vi.unstubAllEnvs());

describe("バージョン情報の頁", () => {
  it("BUILD_COMMIT を渡すと、ビルドの行に commit を全桁・等幅で出す", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    vi.stubEnv("BUILD_COMMIT", commit);
    const html = await render();
    const cell = html.match(/<dd[^>]*data-testid="build-commit"[^>]*>([^<]*)<\/dd>/);
    expect(cell).not.toBeNull();
    expect(cell![1]).toBe(commit);
    expect(cell![0]).toContain("font-mono");
    expect(cell![0]).toContain("text-[13px]");
    expect(cell![0]).toContain("leading-5");
  });

  it("BUILD_COMMIT を渡さなければ、ビルドの行を出さない", async () => {
    vi.stubEnv("BUILD_COMMIT", "");
    expect(await render()).not.toContain('data-testid="build-commit"');
  });
});
