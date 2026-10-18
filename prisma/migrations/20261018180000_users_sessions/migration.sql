-- AUTH_MODE=local（段 1b）の利用者とログインのセッション（docs/spec.md の 3.6）。
-- パスワードは argon2id のハッシュ、TOTP の秘密は暗号化した値だけを持つ。セッションは cookie の token の SHA-256 で引く。
-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "passwordHash" TEXT NOT NULL,
    "passwordChangedAt" DATETIME NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "totpSecretEnc" TEXT,
    "totpEnabledAt" DATETIME,
    "totpLastStep" INTEGER,
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "lastActivityAt" DATETIME NOT NULL,
    "lockedAt" DATETIME,
    "pendingTotpEnc" TEXT,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
