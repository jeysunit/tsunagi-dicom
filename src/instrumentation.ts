// 起動の時に設定を確かめる（docs/spec.md の 2.1・4）。中身は Node.js の側だけ（src/lib/startup.ts）。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkConfigOrExit } = await import("@/lib/startup");
    checkConfigOrExit();
  }
}
