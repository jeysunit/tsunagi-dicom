import { redirect } from "next/navigation";
import { TotpEnrollment } from "@/components/auth/totp-enrollment";
import { startEnrollment } from "@/lib/auth/local-auth";
import { authContext, getAuthState } from "@/lib/auth/session";
import { STAGE_PATHS } from "@/lib/auth/stage-path";

// 二要素が必須（MFA_REQUIRED=true）で、まだ TOTP を登録していない利用者の、ログインの途中の登録。
// 頁を開くたびに新しい秘密を作る（前の秘密は使えなくなる）。
export const metadata = { title: "二要素認証の設定" };

export default async function EnrollPage() {
  const state = await getAuthState();
  if (state.kind !== "pending") redirect(state.kind === "anonymous" ? "/login" : "/");
  if (state.stage !== "enroll") redirect(STAGE_PATHS[state.stage]);
  const enrollment = await startEnrollment(await authContext(), state.row, state.user);
  return (
    <section className="mx-auto w-full max-w-[var(--w-login)] space-y-4 pt-8">
      <h1 className="text-lg font-bold text-value">二要素認証の設定</h1>
      <p className="text-label">二要素認証の設定が必要です。認証アプリを登録してください</p>
      <TotpEnrollment secret={enrollment.secret} uri={enrollment.uri} csrfToken={state.row.csrfToken} />
    </section>
  );
}
