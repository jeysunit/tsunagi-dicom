-- 認証の世代（段 1b。docs/spec.md の 3.6）。パスワードの変更・TOTP の登録・TOTP のやり直しで利用者の値を 1 つ増やし、
-- セッションは作った時の値を持つ。要求のたびに照らし合わせ、違うセッションは使わない（ほかのセッションの削除は後片付け）。
-- AlterTable
ALTER TABLE "User" ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Session" ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 0;
