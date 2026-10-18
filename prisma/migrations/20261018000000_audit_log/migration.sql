-- CreateTable
CREATE TABLE "AuditLog" (
    "seq" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "occurredAt" DATETIME NOT NULL,
    "actorId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "authMode" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "patientId" TEXT,
    "studyInstanceUid" TEXT,
    "sourceAddress" TEXT,
    "detail" TEXT,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_prevHash_key" ON "AuditLog"("prevHash");

-- CreateIndex
CREATE UNIQUE INDEX "AuditLog_hash_key" ON "AuditLog"("hash");

-- CreateIndex
CREATE INDEX "AuditLog_occurredAt_idx" ON "AuditLog"("occurredAt");

-- CreateIndex
CREATE INDEX "AuditLog_patientId_idx" ON "AuditLog"("patientId");

-- CreateIndex
CREATE INDEX "AuditLog_studyInstanceUid_idx" ON "AuditLog"("studyInstanceUid");

-- 監査の記録は追記だけ（docs/spec.md の 3.6）。更新と削除はデータベースの側でも断る。
-- アプリには更新・削除の道を作らない。データベースのファイルを直に書き換えられたときは、
-- ハッシュのつなぎの確かめ（src/lib/audit.ts の verifyAuditChain）で見つける。
CREATE TRIGGER "AuditLog_no_update" BEFORE UPDATE ON "AuditLog"
BEGIN
    SELECT RAISE(ABORT, 'AuditLog is append-only');
END;

CREATE TRIGGER "AuditLog_no_delete" BEFORE DELETE ON "AuditLog"
BEGIN
    SELECT RAISE(ABORT, 'AuditLog is append-only');
END;
