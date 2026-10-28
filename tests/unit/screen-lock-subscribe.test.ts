import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// jsdom を持たないので、useSyncExternalStore だけを「購読して、ブラウザ側の値（getSnapshot）を返す」形に差し替え、
// ロックの状態が購読側へ届き、上の帯の右端が何も描かなくなることを確かめる
const subscribed: Array<{ subscribe: (l: () => void) => () => void; getSnapshot: () => boolean }> = [];
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: (subscribe: (l: () => void) => () => void, getSnapshot: () => boolean) => {
      subscribed.push({ subscribe, getSnapshot });
      return getSnapshot();
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { HeaderAccount } from "@/components/layout/header-account";
import { setScreenLocked } from "@/lib/client/screen-lock-store";

const user = { displayName: "試験 太郎", username: "e2e-user", roleLabel: "一般", csrfToken: "csrf" };

describe("画面のロックの状態が購読側へ届く", () => {
  afterEach(() => {
    setScreenLocked(false);
    subscribed.length = 0;
  });

  it("setScreenLocked(true) で、購読側に知らせが届き、値が true になる", () => {
    renderToString(createElement(HeaderAccount, { user }));
    const { subscribe, getSnapshot } = subscribed[0]!;
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);
    expect(getSnapshot()).toBe(false);
    setScreenLocked(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getSnapshot()).toBe(true);
    // 同じ値なら知らせない・購読をやめたら知らせない
    setScreenLocked(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    setScreenLocked(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("ロックの状態では、HeaderAccount は利用者・画面ロック・ログアウトを描かない", () => {
    setScreenLocked(true);
    const html = renderToString(createElement(HeaderAccount, { user }));
    expect(html).toBe("");
  });

  it("ロックを解けば、また描く", () => {
    setScreenLocked(true);
    setScreenLocked(false);
    const html = renderToString(createElement(HeaderAccount, { user }));
    expect(html).toContain("試験 太郎");
    expect(html).toContain("ログアウト");
  });
});
