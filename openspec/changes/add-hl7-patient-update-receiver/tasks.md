# Tasks

## 1. 仕様

- [x] 1.1 `docs/spec.md` の 3.5 の「値の修正」に、HL7 経由の書き換えは UID を保つ例外を足し、HL7 の受け口の項を足す。2.1 に `HL7_RECEIVER_TOKEN_FILE`・`HL7_PATIENT_ID_ISSUER`、3.6 の監査の記録に `hl7` を足す。`AGENTS.md` の設計の決まりに、機械の主体の例外を足す
- [x] 1.2 `openspec validate add-hl7-patient-update-receiver --strict` が通ることを確かめる

## 2. 共通の部品

- [x] 2.1 制御文字を見える形にする関数（design.md の 10）を、受け口と BFF の両方から使える形で足し、C0・DEL・C1・双方向の書式の字・行と段落の区切り・ふつうの日本語の試験を足す

## 3. BFF：解析と ACK

- [x] 3.1 `src/lib/hl7/` に HL7 v2.3.1 の解析（区切り・繰り返し・成分・エスケープ・UTF-8・MSH-18・MSH-12）を足し、design.md の 5 の断る場面ごとの単体の試験と、ris-emulator の 06 の 3 章の 3 つの例が読める試験を足す
- [x] 3.2 ACK の組み立て（design.md の 7）と、AA・AE・AR・MSH が読めないときの試験を足す
- [x] 3.3 PID・MRG・ORC・OBR・ZDS から反映の中身を取り出す処理（患者 ID・氏名の XPN から PN・生年月日・性別・受付番号・UID）と試験を足す

## 4. BFF：Orthanc への反映と監査

- [x] 4.1 `Backend` に、患者 ID で検査を探す読み取り（`/tools/find`）と、UID を保つ書き換え（`/studies/{id}/modify`。design.md の 3）を足す。`http.ts` とモックの両方に足し、要求の本文（`Keep`・`Force`・`KeepSource: false`）と、答えが来ないときの結果不明の試験を足す
- [x] 4.2 監査の記録に操作 `hl7` を足し、A40・A08・ORM の反映（design.md の 6・8・9・13）を作る。発番元・替え先の患者の属性・書き換えの前に記録できなければ呼ばない・旧い患者が無ければ AA・ORM の患者 ID の不一致と別の受付番号は AE・途中の失敗で止まる・日本語と文字の集合、の試験を足す
- [x] 4.3 Orthanc の仕事としての書き換え・画像ごとの確かめ（design.md の 4）、同じメッセージの送り直し・解いていない書き換えの照らし合わせ・途中で止まったメッセージ・管理者が解く `POST /api/hl7/resolve`（design.md の 10）を作り、spec の場面ごとの試験を足す
- [x] 4.4 `POST /api/hl7/messages` と設定 `HL7_RECEIVER_TOKEN_FILE`・`HL7_PATIENT_ID_ISSUER` を足す（design.md の 3）。設定が無ければ 404、片方だけは起動しない、token の誤り・セッションだけの要求は 401、本文の形と大きさの誤りは 400、検証モードの書き込みの止め、待ちの上限の 503、メッセージを 1 通ずつ順に処理する、の試験を足す

## 5. 受け口

- [x] 5.1 `hl7-receiver/` に MLLP の受け口を足す（Node.js の標準の部品だけ。design.md の 12）。許可の一覧（IP・CIDR・名前・IPv4 を写した IPv6・読めない項目・名前を引けない）・断った知らせの間引き・1 MiB・30 秒・同時 8・枠の外のバイト・1 つの接続で複数のメッセージ・BFF を待つ間の読み取りの止め・BFF が答えないときは ACK を返さずに閉じる、の試験を足す
- [x] 5.2 受け口の Dockerfile（root でない利用者・読み取りだけのファイルの置き場）を足す

## 6. 結合の試験と開発の一式

- [x] 6.1 結合の試験の Orthanc を `OverwriteInstances: true` にし（いまの場面が送り直しの無視に頼っていないことを先に確かめる）、A40 の後に UID が同じまま患者 ID が替わり元の検査が残らないこと、A08 で氏名が替わること、ORM で受付番号が入ること、替え先の患者がすでにある A40（属性が同じなら通り、違えば AE で両方の検査が変わらない）を、画像ごとの UID の組・値・件数・元の検査の有無まで確かめる場面を足す。仕事の途中の失敗（`partial`）は、実の Orthanc で起こす手段が無いので、モックの試験で確かめる（PR に書く）
- [ ] 6.2 開発の一式に受け口を足し（`hl7` と `backend` のネットワーク、ホストにポートを出さない。design.md の 2）、Orthanc を `OverwriteInstances: true` にし、ris-emulator の版を上げ、`up.sh` で token を作る
- [ ] 6.3 開発の一式で、ris-emulator の `pir send`（A40・A08・ORM）から受け口を通して Orthanc が書き換わることを確かめ、`docs/round-trip-test.md` に手順と結果を書く

## 7. まとめの確かめ

- [x] 7.1 `npm run lint`・`npm run typecheck`・`npm test`・`npm run build`・`npm run test:e2e` がすべて通ることを確かめる

## Workflow follow-up

- PR のレビューの後に、この change を archive する

## 2026-10-24 実装と検証の補足

- 2〜5 と 6.1 は実装と試験を終えた。6.1 の結合の試験は、手元の Docker で 17 件が通った。6.2・6.3 は続く PR で出す。
- OverwriteInstances の根拠：結合の試験で Orthanc へ画像を入れる箇所（共通の準備・詳細の条件・日本語のタグ・HL7）は、どれも新しい UID の検査を 1 回入れるだけで、送り直しの無視に頼っていない。
- この change の途中で書いた HL7 の試験のうち、設計の直し（発番元・明示の削除・MSH-18 が空の日本語・替え先の患者の値・不正な CIDR）に合わせて期待を替えたものがある。main にあった試験の期待は替えていない。
