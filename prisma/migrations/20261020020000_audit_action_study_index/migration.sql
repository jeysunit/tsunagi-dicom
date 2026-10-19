-- 書き込みの操作（段 5。docs/spec.md の 3.5）の、同じ検査の要求（解いていない結果不明の要求）を、期間で切らずに探すための索引。
-- 監査の記録の行の中身と hash は変えない（索引を足すだけ）。
-- CreateIndex
CREATE INDEX "AuditLog_action_studyInstanceUid_idx" ON "AuditLog"("action", "studyInstanceUid");
