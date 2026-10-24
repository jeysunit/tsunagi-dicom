# Tasks

## 1. 仕様

- [x] 1.1 `docs/spec.md` の 3.5 に、ORM の CA・DC・XO と照合の後に届く画像の書き換えを足し、`docs/security-and-maintenance.md` と `hl7-receiver/README.md` を直す

## 2. ORM の CA・DC・XO

- [x] 2.1 `src/lib/hl7/update.ts` で ORC-1 の NW・CA・DC・XO を受け、`apply.ts` で CA・DC は受付番号を外し、XO は NW と同じにする。`tests/unit/hl7-message.test.ts`・`hl7-case6.test.ts` で、受ける・断る ORC-1、CA・DC の書き換え、受付番号と患者 ID の違い、送り直しを確かめる

## 3. 照合の後に届く画像

- [x] 3.1 A40 と ORM の受理で `ack` の行に覚えを入れる
- [x] 3.2 `Backend` に `studyIsStable` を足し（`http.ts`・モック）、`tests/unit/hl7-http-backend.test.ts` で確かめる
- [x] 3.3 `src/lib/hl7/sweep.ts` に見回り（design.md の 15）を書き、確かめを同じ StudyInstanceUID の全部の検査で行うようにする。`tests/unit/helpers/fake-orthanc.ts` の画像ごとの Orthanc で、`tests/unit/hl7-case6.test.ts` に、書き換える場面と書き換えない場面（別の患者・覚えに無い検査・期限の外・2 段・先が決まらない・氏名の違い・同じ UID の別の患者・届き終えていない・最中に届いた・止まっていた間に届いた・結果不明・検証モード・同時に届く）を足す
- [x] 3.4 `POST /api/hl7/sweep` と、受け口の定期の呼び出しを足し、`tests/unit/hl7-sweep-route.test.ts` で token・設定の無いとき・重ねない呼び出し・誤りの続く BFF を確かめる

## 4. 確かめ

- [x] 4.1 lint・型・Vitest が合格することを確かめる
- [ ] 4.2 開発の一式で、照合の後の追加撮影（Case 6）と取消の ORM を通しの試験（`tests/flow/flow.spec.ts`）で確かめる（PIR の順 5 の 4。別の PR）
- [ ] 4.3 CI が緑であることを確かめる

## Workflow follow-up

- PR のレビューの後に、この change を archive する
