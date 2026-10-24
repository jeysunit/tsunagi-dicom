# Tasks

## 1. 仕様

- [ ] 1.1 `docs/spec.md` の 3.5 の「値の修正」に、HL7 経由の書き換えは UID を保つ例外を足し、HL7 の受け口の項を足す。2.1 に `HL7_RECEIVER_TOKEN_FILE`、3.6 の監査の記録に `hl7` を足す
- [ ] 1.2 `openspec validate add-hl7-patient-update-receiver --strict` が通ることを確かめる

## 2. 共通の部品

- [ ] 2.1 制御文字を見える形にする関数（design.md の 10）を、受け口と BFF の両方から使える形で足し、C0・DEL・C1・双方向の書式の字・行と段落の区切り・ふつうの日本語の試験を足す

## 3. BFF：解析と ACK

- [ ] 3.1 `src/lib/hl7/` に HL7 v2.3.1 の解析（区切り・繰り返し・成分・エスケープ・UTF-8・MSH-18・MSH-12）を足し、design.md の 5 の断る場面ごとの単体の試験と、ris-emulator の 06 の 3 章の 3 つの例が読める試験を足す
- [ ] 3.2 ACK の組み立て（design.md の 7）と、AA・AE・AR・MSH が読めないときの試験を足す
- [ ] 3.3 PID・MRG・ORC・OBR・ZDS から反映の中身を取り出す処理（患者 ID・氏名の XPN から PN・生年月日・性別・受付番号・UID）と試験を足す

## 4. BFF：Orthanc への反映と監査

- [ ] 4.1 `Backend` に、患者 ID で検査を探す読み取り（`/tools/find`）と、UID を保つ書き換え（`/studies/{id}/modify`。design.md の 3）を足す。`http.ts` とモックの両方に足し、要求の本文（`Keep`・`Force`・`KeepSource: false`）と、答えが来ないときの結果不明の試験を足す
- [ ] 4.2 監査の記録に操作 `hl7` を足し、A40・A08・ORM の反映（design.md の 6・9）を作る。書き換えの前に記録できなければ呼ばない・旧い患者が無ければ AA・ORM の患者 ID の不一致と別の受付番号は AE・途中の失敗で止まる、の試験を足す
- [ ] 4.3 `POST /api/hl7/messages` と設定 `HL7_RECEIVER_TOKEN_FILE` を足す。設定が無ければ 404、token の誤り・セッションだけの要求は 401、本文の形の誤りは 400、メッセージを 1 通ずつ順に処理する、の試験を足す

## 5. 受け口

- [ ] 5.1 `hl7-receiver/` に MLLP の受け口を足す（Node.js の標準の部品だけ）。許可の一覧（IP・CIDR・名前）・断った知らせの間引き・1 MiB・30 秒・同時 8・枠の外のバイト・1 つの接続で複数のメッセージ・BFF が答えないときは ACK を返さずに閉じる、の試験を足す
- [ ] 5.2 受け口の Dockerfile（root でない利用者・読み取りだけのファイルの置き場）を足す

## 6. 結合の試験と開発の一式

- [ ] 6.1 結合の試験（本物の Orthanc）に、A40 の後に UID が同じまま患者 ID が替わり、元の検査が残らないことを確かめる場面を足す
- [ ] 6.2 開発の一式に受け口を足し（`dicom` と `backend` のネットワーク、ホストにポートを出さない）、Orthanc を `OverwriteInstances: true` にし、ris-emulator の版を上げ、`up.sh` で token を作る
- [ ] 6.3 開発の一式で、ris-emulator の `pir send`（A40・A08・ORM）から受け口を通して Orthanc が書き換わることを確かめ、`docs/round-trip-test.md` に手順と結果を書く

## 7. まとめの確かめ

- [ ] 7.1 `npm run lint`・`npm run typecheck`・`npm test`・`npm run build`・`npm run test:e2e` がすべて通ることを確かめる

## Workflow follow-up

- PR のレビューの後に、この change を archive する
