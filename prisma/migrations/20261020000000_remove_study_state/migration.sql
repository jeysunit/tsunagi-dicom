-- 検査の状態の印（検像・読影・緊急・ブックマーク）を外す（段 3。docs/spec.md の 0）。
-- 検査ごとに覚えたビューアは StudyViewer に移す。覚えの値と版はそのまま移す（版を残すのは、古い画面からの上書きを
-- これまでどおり 409 で断るため。覚えの無い行も、版を残すために移す）。
-- 監査の記録（AuditLog）は追記だけの決まりなので、段 2 の状態の変更の行（study_state）は消さずに残る。
-- CreateTable
CREATE TABLE "StudyViewer" (
    "studyInstanceUid" TEXT NOT NULL PRIMARY KEY,
    "viewer" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedBy" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "StudyViewer" ("studyInstanceUid", "viewer", "version", "updatedBy", "updatedAt")
SELECT "studyInstanceUid", "viewer", "version", "updatedBy", "updatedAt" FROM "StudyState";

-- DropTable
DROP TABLE "StudyState";

-- DropTable
DROP TABLE "StudyBookmark";
