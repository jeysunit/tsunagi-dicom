-- 利用者ごとの画面の設定（段 2。docs/spec.md の 2）。いまは地の色（明るい地・暗い地）だけ。
-- CreateTable
CREATE TABLE "UserPreference" (
    "actorId" TEXT NOT NULL PRIMARY KEY,
    "theme" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
