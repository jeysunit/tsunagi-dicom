# Proposal

## Why

IHE Radiology の PIR（Patient Information Reconciliation）を、ris-emulator・DTG・tsunagi-dicom の 3 つの OSS で再現して試したい。
緊急の撮影は仮の患者 ID で撮られ、あとで RIS が正式な患者と予約に結び直す。結び直した結果は、RIS が HL7 v2 で PACS に知らせる。
いまの tsunagi-dicom は HL7 を受けないので、RIS が送った患者の統合や受付番号が、Orthanc の検査に入らない。
RIS の送り手（ris-emulator の `pir send`。`docs/spec/06_hl7_pir.md`）は用意できたので、受け手を作り、両者が規格どおりに噛み合うかを試せるようにする。

## What Changes

- HL7 v2.3.1 を MLLP で受ける「受け口」を、別の小さなコンテナとして足す。受け口は TCP で待ち受け、送り手の住所を許可の一覧で絞り、メッセージの大きさと待ち時間に上限を置く。
  受けたメッセージは BFF の内部の API に渡し、BFF が返した ACK を送り手へ返す。受け口は Orthanc を直に呼ばない。
- BFF に内部の API（`POST /api/hl7/messages`）を足す。共有の token（`HL7_RECEIVER_TOKEN_FILE`）で受け口だけを通し、設定が無ければ道を開かない。受ける患者 ID の発番元は設定（`HL7_PATIENT_ID_ISSUER`）で 1 つに決める。
  BFF はメッセージを解析し、次の 3 つを Orthanc に反映して ACK（AA・AE・AR）を作る。
  - ADT^A40（患者の統合）：MRG の旧い患者 ID の検査を、PID の患者 ID と属性に書き換える。
  - ADT^A08（患者の属性の更新）：PID の患者 ID の検査の、氏名・生年月日・性別を書き換える。患者 ID は変えない。
  - ORM^O01 の NW（予約の知らせ）：ZDS の Study Instance UID の検査に、受付番号を入れる。
- **HL7 経由の書き換えでは UID を保つ。** Orthanc の `/studies/{id}/modify` に `Keep`（Study・Series・SOP の 3 つの UID）・`Force: true` を渡し、患者 ID が変わる A40 だけは `KeepSource: false` も渡す（2026-10-24 の実測。design.md の 4）。
  画面の「値の修正」（段 6）は、いまの方針（UID を新しくする）のまま変えない。
- 壊れたメッセージ・扱わない種類のメッセージには AR を返し、Orthanc を変えない。旧い患者が Orthanc に無い A40 は、何もせずに AA を返す。
- 同じメッセージの送り直しには前と同じ ACK を返し、結果の分からない書き換えは次のメッセージの前に Orthanc と照らす（照らせなければ止める）。
- 監査の記録に `hl7` の操作を足す。断った接続、AR、Orthanc を呼ぶ前と後（前と後の値・元と新しい Orthanc の ID）を残す。
- 外から来た値を、ログ・監査の記録の理由・ACK の文に出す前に、制御文字を見える形（`\uXXXX`）に置き換える。
- 開発の一式（`docker/dev`）に受け口を足し、ris-emulator から `pir send` で届く形にする。開発の一式と結合の試験の Orthanc は `OverwriteInstances: true` にする（design.md の 5）。

## Capabilities

### New Capabilities

- `hl7-patient-update`: HL7 v2.3.1 の受け口（MLLP・許可の一覧・上限）、BFF の内部の API、A40・A08・ORM の NW の Orthanc への反映、ACK、監査の記録

### Modified Capabilities

（なし。`openspec/specs/` にある `instance-tags` は変わらない）

## Impact

- 新しい受け口：`hl7-receiver/`（Node.js の標準の部品だけで書き、依存を足さない）と、その Dockerfile
- BFF：`src/lib/hl7/`（解析・ACK・反映）、`src/app/api/hl7/messages/route.ts`、`src/lib/config.ts`（`HL7_RECEIVER_TOKEN_FILE`）、`src/lib/audit.ts`（操作 `hl7`）
- バックエンド：`Backend` に、患者 ID で検査を探す読み取りと、UID を保った書き換えを足す（`http.ts` とモック）
- 画像サーバーへの要求：`/tools/find`（読み取り）と `/studies/{id}/modify`（書き込み）を足す。書き込みはこの受け口の道からだけ呼ぶ
- 配る compose（`deploy/compose.yaml`）は変えない。受け口は開発の一式だけに入れる。結合の試験の Orthanc（`docker/test`）は `OverwriteInstances: true` にする
- `AGENTS.md`：書き込みの操作の決まりに、機械の主体の例外を 1 行足す
- 文書：`docs/spec.md`（2.1 の設定・3.5 の値の修正と HL7 の受け口・3.6 の監査の記録）、`docs/security-and-maintenance.md`、`docs/round-trip-test.md`、README
