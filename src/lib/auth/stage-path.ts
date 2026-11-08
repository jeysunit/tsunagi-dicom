import type { Stage } from "@/lib/auth/local-auth";

/** ログインのステップごとに開く頁 */
export const STAGE_PATHS: Record<Stage, string> = {
  totp: "/login/totp",
  enroll: "/login/enroll",
  change_password: "/login/password",
  active: "/",
};
