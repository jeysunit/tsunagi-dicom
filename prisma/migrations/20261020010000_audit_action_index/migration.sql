-- 書き込みの操作（段 4。docs/spec.md の 3.5）の要求の ID を、決めた期間の中の同じ操作の行だけから探すための索引。
-- 監査の記録の行の中身と hash は変えない（索引を足すだけ）。
-- CreateIndex
CREATE INDEX "AuditLog_action_occurredAt_idx" ON "AuditLog"("action", "occurredAt");
