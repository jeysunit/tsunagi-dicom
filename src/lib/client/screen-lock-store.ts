import { useSyncExternalStore } from "react";

// 画面ロックの状態を、LockGuard の外（上の帯）へ伝える。上の帯は LockGuard の外に描かれるので、
// 画面の側でロックしたとき（頁を読み直すまでの間）に利用者の名前などを外すために使う。
let locked = false;
const listeners = new Set<() => void>();

/** LockGuard が、ロックの状態が変わるたびに呼ぶ */
export function setScreenLocked(next: boolean) {
  if (locked === next) return;
  locked = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 画面がロックしているか。サーバーで描くときの値は、BFF が描いた状態（頁の側で利用者を渡さない）に任せて false */
export function useScreenLocked(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => locked,
    () => false,
  );
}
