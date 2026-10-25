// 照合の後に届いた画像の書き換えを、BFF に定期に頼む（design.md §15）。受け口が止まっていた間に届いた画像も、
// 起き直した後の最初の呼び出しで拾う（BFF は Orthanc にある画像を見るので、受け口は何も覚えない）。
import { visible } from "./visible.ts";

export interface SweeperOptions {
  url: string;
  token: string;
  intervalMs: number;
  timeoutMs: number;
  /** 起きてから最初に呼ぶまでの時間（BFF が立つのを待つ） */
  firstDelayMs?: number;
  log?: (line: string) => void;
}

/** 前の呼び出しが終わるまで次を呼ばない。止める関数を返す。 */
export function startSweeper(options: SweeperOptions): () => void {
  const log = options.log ?? console.error;
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) {
      return;
    }
    running = true;
    try {
      const res = await fetch(options.url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}` },
        signal: AbortSignal.timeout(options.timeoutMs),
        redirect: "error"
      });
      await res.body?.cancel();
      if (!res.ok) {
        log(`HL7 の照合の後の画像の書き換えを頼めなかった（${res.status}）`);
      }
    } catch (error) {
      log(`HL7 の照合の後の画像の書き換えを頼めなかった（${visible(error instanceof Error ? error.message : "不明")}）`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), options.firstDelayMs ?? 5000);
  const timer = setInterval(() => void tick(), options.intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
