# Tasks

## 1. 設定 `INSTANCE_TAGS`

- [ ] 1.1 `src/lib/config.ts` に `INSTANCE_TAGS` を足し、`screen.instanceTags`（8 桁の大文字の 16 進の配列）にする。未設定・空は既定の 25 のタグ（design.md の 5）、3 つの書き方・大文字と小文字・空白の区切りを受け、形の誤り・重なり・100 個を超える数を `ConfigError` で断る。`tests/unit/config.test.ts` に spec の「出すタグの一覧の設定」の 4 つの場面を足し、`npx vitest run tests/unit/config.test.ts` が通ることを確かめる
- [ ] 1.2 `.env.example` の「画面」に `INSTANCE_TAGS=""` と、書き方の 1 行の例を足し、`docs/spec.md` の 2.1 の「画面」の行に同じ要点を足す。`.env.example` を読み込む試験（`tests/unit/config.test.ts` の例の読み込み）が通ることを確かめる

## 2. 値の組み立てとタグ名

- [ ] 2.1 `src/lib/all-values.ts` に、設定のタグを設定の順に選び出す関数を足す（画像に無いタグは `vr: ""`・`value: null`）。1024 文字を超える値は先頭の 1024 文字（符号位置で数え、サロゲートの組を割らない）と `length` を返す。`tests/unit` に、順・無いタグ・設定に無いタグが入らないこと・5000 文字の値・絵文字を含む値の切り方・バイナリ（VR の 7 つと InlineBinary・BulkDataURI）・SQ・PN・HTML の形の値の試験を足して通す
- [ ] 2.2 タグ名の表（既定の 25 と、患者・検査・シリーズの主なタグの keyword）を足し、表に無いタグ・私的タグはタグ名を空にする。既定の 25 のタグがすべて表にあることを試験で確かめる

## 3. 画面の API とモック

- [ ] 3.1 `GET /api/studies/{uid}/series/{series}/instances/{sop}/tags` を足す（`dicom.all_values`・UID の形の確かめ・`instanceDataset` で読む・`view_study` の `detail` に `set: "configured"`）。`…/values` の `detail` に `set: "all"` を足す。経路の試験（`tests/unit/screen-routes.test.ts` の形）で、一般と管理者に返る・権限を外した役割は 403 で断った記録が残る・設定に無いタグが返らない・UID の形の誤りは 400・画像が無ければ 404 を確かめる
- [ ] 3.2 モックの画像単位の値の見本に、長い値（5000 文字の ImageComments）・HTML の形の値・バイナリの値を足し、`tests/unit/mock-backend.test.ts` と `tests/unit/fixtures-hygiene.test.ts` が通ることを確かめる（合成の患者だけ。`tests/fixtures/orthanc/README.md` の置き換えの規則に従う）

## 4. 画面

- [ ] 4.1 `docs/spec.md` の 2.2 の用語集に「主なタグ・すべてのタグ・タグ名」を足し、3.1 の詳細のパネルを、サムネイルから開く画像の場所と「DICOM タグ」を検査単位だけにする形に書き直す（文書の組み直しはしない。該当の段落の書き換えだけ）
- [ ] 4.2 サムネイルを、権限のある役割ではボタン（`aria-pressed`・読み上げの名前にシリーズの番号とシリーズ名）にし、押すと画像の場所を開く・同じものでもう一度押すと閉じる・行を替えると閉じる形にする。権限の無い役割では、いまの絵のまま押せない
- [ ] 4.3 画像の場所（画像の一覧・上下の矢印のキー・SOPInstanceUID とコピー・タグ・タグ名・VR・値の表・「主なタグ／すべてのタグ」の切り替え・768px 未満は上下に重ねる）を作る。読み直す間と失敗したときに前の値を出さない（いまの `AUDITED_READ` と同じ）。値は文字として出し、長い値には「…（全 N 文字）」を添える
- [ ] 4.4 「DICOM タグ」から「検査単位（要約）・画像単位」の切り替えと画像単位の欄を外す
- [ ] 4.5 `tests/e2e/study-list.spec.ts` の画像単位の DICOM タグの試験を、サムネイルから開く流れの試験に移す（同じ確かめ：シリーズと画像の選び直しで値が替わり、前の値が残らない。試験の書き換えになるので、理由を PR に書く）。spec の「サムネイルからシリーズの画像の場所を開く」「画像の一覧」「主なタグとすべてのタグを切り替える」「DICOM タグは検査単位だけにする」の場面と、権限を外した役割の場面を足し、`npm run test:e2e -- tests/e2e/study-list.spec.ts` が通ることを確かめる
- [ ] 4.6 README の機能の説明に、サムネイルを押すと画像ごとのタグを見られることと `INSTANCE_TAGS` を足す

## 5. 結合の試験（本物の Orthanc）

- [ ] 5.1 試験の画像（dump）に、SpecificCharacterSet が `\ISO 2022 IR 87` の合成の患者の画像を足し、結合の試験の 12 に、`…/tags` が漢字とかなの氏名を崩さずに返すことと、設定に無いタグが返らないことを足す。`node tests/integration/run.mjs -g "画像単位"` が通ることを確かめ、`docs/integration-test.md` の 12 の行と、`round-trip-test.md` の「実測で決めること」に結果を書く
- [ ] 5.2 5.1 で Orthanc が返した ISO 2022 IR 87 の画像の `metadata` を、置き換えの規則に従ってモックの見本に写し、モックでも日本語の値の場面（spec の「日本語の値」）を e2e で確かめる

## 6. まとめの確かめ

- [ ] 6.1 `npm run lint`・`npm run typecheck`・`npm test`・`npm run build` と `npm run test:e2e` がすべて通り、`openspec validate series-instance-tags --strict` が通ることを確かめる

## Workflow follow-up

- PR のレビューの後に、この change を archive する
