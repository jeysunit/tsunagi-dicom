import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// 画面ロックの状態を上の帯へ伝える窓口（src/lib/client/screen-lock-store.ts）と、
// ロックの間は利用者・画面ロック・ログアウトを描かない上の帯の右端（header-account.tsx）
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { HeaderAccount } from "@/components/layout/header-account";
import { setScreenLocked } from "@/lib/client/screen-lock-store";

const user = { displayName: "試験 太郎", username: "e2e-user", roleLabel: "一般", csrfToken: "csrf" };

describe("上の帯の利用者（画面のロック）", () => {
  afterEach(() => setScreenLocked(false));

  it("ロックしていなければ、利用者・画面ロック・ログアウトを描く", () => {
    const html = renderToString(createElement(HeaderAccount, { user }));
    expect(html).toContain("試験 太郎");
    expect(html).toContain("画面ロック");
    expect(html).toContain("ログアウト");
  });

  it("ロックの状態にしても、サーバーで描く値は変えない（描いた頁の側が利用者を渡さない）", () => {
    setScreenLocked(true);
    const html = renderToString(createElement(HeaderAccount, { user }));
    expect(html).toContain("試験 太郎");
  });
});
