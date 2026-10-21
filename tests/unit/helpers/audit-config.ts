import type * as ConfigModule from "@/lib/config";

// 監査の記録の鍵（src/lib/audit-key.ts）は、設定（getConfig）の SESSION_SECRET から導く。
// 設定を読まない試験では、getConfig をこの値に差し替える：
//   vi.mock("@/lib/config", async (importOriginal) =>
//     (await import("./helpers/audit-config")).withAuditKey(await importOriginal()));
// 値を替えると、次に書く行から別の鍵になる（SESSION_SECRET を替えたときの試験）。

export const auditTestConfig = {
  sessionSecret: "tsunagi-dicom-audit-test-secret-0123456789",
  audit: { sessionSecretPrevious: [] as string[], anchorFile: undefined as string | undefined },
};

export function withAuditKey(real: typeof ConfigModule): typeof ConfigModule {
  return { ...real, getConfig: () => auditTestConfig as unknown as ReturnType<typeof real.getConfig> };
}
