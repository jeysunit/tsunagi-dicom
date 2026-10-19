-- 役割を管理者（admin）と一般（general）の2つにする（docs/spec.md の 3.6。2026-10-20 に承認者が決めた）。
-- 管理者は管理者のまま、医師（doctor）・技師（technologist）・閲覧（viewer）の利用者は一般にする。
-- ほかの知らない役割の名前は移さない（アプリは知らない役割のセッションを使わせない。src/lib/auth/session.ts）。
-- 監査の記録（AuditLog）の actorRole は、追記だけの決まりのため書き換えない（記録した時の役割の名前のまま残る）。
UPDATE "User" SET "role" = 'general' WHERE "role" IN ('doctor', 'technologist', 'viewer');
