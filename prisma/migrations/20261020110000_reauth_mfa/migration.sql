-- 再認証で TOTP まで確かめた時刻（docs/spec.md の 3.6。2026-10-20）。削除の再認証はパスワードだけで、
-- 利用者の管理の再認証は、TOTP を登録した利用者には TOTP も求める（パスワードとセッションだけで管理者を作り足せないように）。
-- AlterTable
ALTER TABLE "Session" ADD COLUMN "reauthMfaAt" DATETIME;
