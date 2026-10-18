-- 監査の記録の接続元のうち、確かめていない値（X-Forwarded-For など、要求のヘッダーにあったもの）を分けて持つ。
-- 信じるプロキシの設定が無い間は、sourceAddress は空のまま、ヘッダーの値はこの欄に入れる（src/lib/auth/source-address.ts）。
-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "sourceAddressUnverified" TEXT;

-- INSERT OR REPLACE（と REPLACE INTO）は、一意の制約にぶつかった行を消してから足す。
-- その消す動きでは BEFORE DELETE の trigger が動かない（recursive_triggers が既定で切れている）ので、
-- 同じ seq・prevHash・hash の行を足そうとした時点で断る。
CREATE TRIGGER "AuditLog_no_replace" BEFORE INSERT ON "AuditLog"
WHEN EXISTS (
    SELECT 1 FROM "AuditLog"
    WHERE "seq" = NEW."seq" OR "prevHash" = NEW."prevHash" OR "hash" = NEW."hash"
)
BEGIN
    SELECT RAISE(ABORT, 'AuditLog is append-only');
END;
