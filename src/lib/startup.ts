import { ConfigError, loadConfig } from "@/lib/config";

/** 設定に誤りがあれば、どの変数かを出して起動を止める */
export function checkConfigOrExit(): void {
  try {
    const config = loadConfig();
    console.info(
      `tsunagi-dicom: BACKEND_KIND=${config.backend.kind} BACKEND_MOCK=${config.backend.mock} AUTH_MODE=${config.auth.mode}`,
    );
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}
