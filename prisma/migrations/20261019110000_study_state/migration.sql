-- 検査の状態（検像・読影・緊急・検査ごとに覚えたビューア）、利用者ごとのブックマーク、モダリティごとの既定のビューア（段 2。docs/spec.md の 3.1・3.2）。
-- 画像サーバーの DICOM の値は書き換えず、BFF のデータベースに持つ。
-- CreateTable
CREATE TABLE "StudyState" (
    "studyInstanceUid" TEXT NOT NULL PRIMARY KEY,
    "inspected" BOOLEAN NOT NULL DEFAULT false,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "viewer" TEXT,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StudyBookmark" (
    "actorId" TEXT NOT NULL,
    "studyInstanceUid" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,

    PRIMARY KEY ("actorId", "studyInstanceUid")
);

-- CreateTable
CREATE TABLE "ModalityViewerDefault" (
    "modality" TEXT NOT NULL PRIMARY KEY,
    "viewer" TEXT NOT NULL,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);
