// 起動の時に設定を確認する（docs/spec.md の 2.1・4）。AUTH_MODE=local では最初の管理者も確認する。
// 中身は Node.js の側だけ（src/lib/startup.ts）。
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkConfigOrExit } = await import("@/lib/startup");
    await checkConfigOrExit();
  }
}
