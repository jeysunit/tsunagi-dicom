import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// 試験で測った Orthanc の実の振る舞い（docs/integration-test.md の「Orthanc の実の振る舞いの記録」に書く材料）。
// 名前・数・状態・誤りの番号と文言だけを残す。資格情報・住所（RemoteIP など）の値は入れない。

const observed: Record<string, unknown> = {};

export function observe(key: string, value: unknown): void {
  observed[key] = value;
  console.log(`[itest-observation] ${key} = ${JSON.stringify(value)}`);
}

export function writeObservations(): void {
  const dir = path.resolve("test-results/integration");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "observations.json"), `${JSON.stringify(observed, null, 2)}\n`, "utf8");
}
