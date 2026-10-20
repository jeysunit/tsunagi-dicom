-- 再認証の印（docs/spec.md の 3.6。2026-10-20）。
-- reauthMfaAt：再認証で TOTP まで確かめた時刻。削除の再認証はパスワードだけで、利用者の管理の再認証は、TOTP を登録した
--   利用者には TOTP も求める（パスワードとセッションだけで管理者を作り足せないように）。
-- roleVersion・reauthRoleVersion：役割の世代と、再認証を通した時の役割の世代。役割を変えるたびに世代を上げ、
--   世代が違う印は使わない（前の役割で通した印を、格上げの後に使わせない）。
-- AlterTable
ALTER TABLE "Session" ADD COLUMN "reauthMfaAt" DATETIME;
-- AlterTable
ALTER TABLE "Session" ADD COLUMN "reauthRoleVersion" INTEGER;
-- AlterTable
ALTER TABLE "User" ADD COLUMN "roleVersion" INTEGER NOT NULL DEFAULT 0;
