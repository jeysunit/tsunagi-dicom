-- 再認証の印（docs/spec.md の 3.6。2026-10-20）。
-- reauthMfaAt：再認証で TOTP まで確かめた時刻。削除の再認証はパスワードだけで、利用者の管理の再認証は、TOTP を登録した
--   利用者には TOTP も求める（パスワードとセッションだけで管理者を作り足せないように）。
-- roleChangedAt：役割を最後に変えた時刻。これより前に通した再認証の印は使わない（前の役割の印を、格上げの後に使わせない）。
-- AlterTable
ALTER TABLE "Session" ADD COLUMN "reauthMfaAt" DATETIME;
-- AlterTable
ALTER TABLE "User" ADD COLUMN "roleChangedAt" DATETIME;
