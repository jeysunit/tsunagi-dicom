# Spec Delta

## Purpose

HL7 v2.3.1 の患者の統合（ADT^A40）・患者の属性の更新（ADT^A08）・予約の知らせ（ORM^O01 の NW）を MLLP で受け、Orthanc の検査の患者と受付番号を、UID を保ったまま揃える。
受け口は開発の一式の内側だけで待ち受け、送り手の住所で絞る。解析・書き換え・監査の記録は BFF が行う。

## ADDED Requirements

### Requirement: 受け口は許可した送り手からだけ MLLP で受ける

受け口は、許可の一覧（`HL7_ALLOWED_SOURCES`）に合う住所からの接続だけを読まなければならない（SHALL）。一覧に合わない接続は何も読まずに閉じ、BFF に知らせて監査の記録に残す（SHALL）。一覧が空なら、受け口は起動してはならない（SHALL NOT）。

#### Scenario: 許可していない住所から接続が来る

- **WHEN** 許可の一覧に無い住所から受け口に接続する
- **THEN** 受け口は何も読まずに接続を閉じ、監査の記録に `hl7` の `refused`（denied）の行が 1 行足される

#### Scenario: 同じ住所から続けて断る

- **WHEN** 許可していない同じ住所から、1 分の間に 10 回接続する
- **THEN** 10 回とも閉じるが、監査の記録に足されるのは 1 行だけ

#### Scenario: 一覧が空

- **WHEN** `HL7_ALLOWED_SOURCES` を設定せずに受け口を起こす
- **THEN** 受け口は誤りを出して終わり、待ち受けない

### Requirement: 受け口はメッセージの大きさと時間に上限を置く

受け口は、1 通が 1 MiB を超える、枠の外のバイトが来る、接続から 30 秒で 1 通を読み終えない、のどれかで接続を閉じなければならない（SHALL）。同時の接続は 8 までとする（SHALL）。

#### Scenario: 大きすぎるメッセージ

- **WHEN** 許可した送り手が、枠の終わりの無いまま 1 MiB を超えるバイトを送る
- **THEN** 受け口は ACK を返さずに接続を閉じ、BFF には何も渡さない

#### Scenario: 途中で止まる送り手

- **WHEN** 許可した送り手が、枠の始まりだけを送って止まる
- **THEN** 受け口は 30 秒で接続を閉じる

### Requirement: BFF の内部の API は token を持つ受け口だけを通す

BFF の `POST /api/hl7/messages` は、`HL7_RECEIVER_TOKEN_FILE` を設定したときだけ開き（SHALL）、`Authorization: Bearer` の token が合う要求だけを処理しなければならない（SHALL）。画面の利用者のセッションでは通してはならない（SHALL NOT）。

#### Scenario: 設定が無い

- **WHEN** `HL7_RECEIVER_TOKEN_FILE` の無い BFF に要求を送る
- **THEN** 404 が返り、Orthanc は呼ばれない

#### Scenario: token が違う

- **WHEN** 違う token か token の無い要求を送る（管理者のセッションの cookie があっても）
- **THEN** 401 が返り、Orthanc は呼ばれない

### Requirement: 壊れたメッセージ・扱わないメッセージには AR を返す

BFF は、MSH が読めない、区切りが `|^~\&` でない、版が 2.3.1 でない、MSH-18 が空か `UNICODE UTF-8` でない、UTF-8 として正しくない、知らないエスケープがある、値に制御文字がある、扱わない種類（A40・A08・ORM の NW のほか）のメッセージに、AR の ACK を返さなければならない（SHALL）。Orthanc は変えない（SHALL NOT）。

#### Scenario: 形式が壊れたメッセージ

- **WHEN** MSH の無いメッセージを受ける
- **THEN** MSA-1 が AR の ACK が返り、Orthanc は変わらず、監査の記録に `rejected`（denied）の行が残る

#### Scenario: 扱わない種類

- **WHEN** ADT^A03 や、ORC-1 が CA の ORM を受ける
- **THEN** AR の ACK が返り、Orthanc は変わらない

#### Scenario: 値に制御文字

- **WHEN** PID-5 に `\X1B\` のエスケープや ESC の字を含むメッセージを受ける
- **THEN** AR の ACK が返り、理由の文と監査の記録の理由では、制御文字が `\u001B` の形で出る

### Requirement: A40 で旧い患者の検査を新しい患者 ID に書き換え、UID を保つ

BFF は ADT^A40 を受けたら、MRG-1 の旧い患者 ID の検査を全部、PID の患者 ID・氏名・生年月日・性別に書き換えなければならない（SHALL）。Study・Series・SOP の各 UID は保ち（SHALL）、元の検査は Orthanc に残してはならない（SHALL NOT）。

#### Scenario: 仮の患者 ID の検査がある

- **WHEN** 仮の患者 ID `ER2026102400` の検査が Orthanc にあり、PID-3 が `P000001`、MRG-1 が `ER2026102400` の A40 を受ける
- **THEN** AA の ACK が返り、その検査は同じ StudyInstanceUID・SeriesInstanceUID・SOPInstanceUID のまま患者 ID `P000001` になり、患者 ID `ER2026102400` の検査は Orthanc に残らない

#### Scenario: 漢字とかなの氏名

- **WHEN** PID-5 が `TANAKA^HIROSHI^^^^^L^A~田中^博^^^^^L^I~タナカ^ヒロシ^^^^^L^P`、MSH-18 が `UNICODE UTF-8` の A40 を受ける
- **THEN** 検査の氏名は `TANAKA^HIROSHI=田中^博=タナカ^ヒロシ` になる

#### Scenario: 旧い患者が Orthanc に無い

- **WHEN** MRG-1 の患者 ID の検査が Orthanc に無い A40 を受ける
- **THEN** 何も書き換えずに AA の ACK が返り、監査の記録の `ack` の行に書き換えた件数 0 が残る

#### Scenario: 替え先の患者がすでにある

- **WHEN** PID-3 の患者 ID の検査が Orthanc にすでにあり、PID-7 が空の A40 を受ける
- **THEN** 書き換えた検査の生年月日は、元の検査のいまの値のままで、Orthanc は 400 を返さない

### Requirement: A08 で患者の属性を書き換え、患者 ID は変えない

BFF は ADT^A08 を受けたら、PID-3 の患者 ID の検査の、氏名・生年月日・性別を書き換えなければならない（SHALL）。PID の空の欄は変えない（SHALL NOT）。患者 ID と UID は変えない（SHALL NOT）。

#### Scenario: 氏名だけを直す

- **WHEN** 患者 ID `P000001` の検査があり、氏名だけを変えた A08 を受ける
- **THEN** AA の ACK が返り、検査の氏名が替わり、患者 ID・生年月日・UID は変わらない

#### Scenario: 患者が無い

- **WHEN** PID-3 の患者 ID の検査が Orthanc に無い A08 を受ける
- **THEN** 何も書き換えずに AA の ACK が返る

### Requirement: ORM の NW で Study Instance UID の検査に受付番号を入れる

BFF は ORM^O01 の NW を受けたら、ZDS-1 の Study Instance UID の検査の受付番号を OBR-18 の値にしなければならない（SHALL）。検査の患者 ID が PID-3 と違うとき、または別の受付番号がすでに入っているときは、書き換えずに AE を返さなければならない（SHALL）。

#### Scenario: 受付番号が空の検査

- **WHEN** 受付番号が空の検査に、同じ患者 ID・同じ StudyInstanceUID の ORM（OBR-18 が `RE202610210001`）を受ける
- **THEN** AA の ACK が返り、検査一覧の受付番号が `RE202610210001` になる。UID は変わらない

#### Scenario: 患者 ID が合わない

- **WHEN** 検査の患者 ID と ORM の PID-3 が違う
- **THEN** AE の ACK が返り、検査は変わらない

#### Scenario: 検査がまだ無い

- **WHEN** ZDS-1 の StudyInstanceUID の検査が Orthanc に無い
- **THEN** 何も書き換えずに AA の ACK が返る

### Requirement: 書き換えは監査の記録を通す

BFF は Orthanc の書き換えを呼ぶ前に `hl7` の `request` の行を残し、残せなければ呼ばずに AE を返さなければならない（SHALL）。呼んだ後に、前と後の値・元と新しい Orthanc の ID・StudyInstanceUID を `result` の行に残す（SHALL）。答えが来なければ `result` を `unknown` にして AE を返す（SHALL）。

#### Scenario: 記録できない

- **WHEN** 監査の記録の追記が失敗する
- **THEN** Orthanc の書き換えは呼ばれず、AE の ACK が返る

#### Scenario: 書き換えの前と後

- **WHEN** A40 で 1 件の検査を書き換える
- **THEN** 監査の記録に `request` と `result` の行が同じ要求の ID で残り、`result` に前と後の患者 ID・氏名と、元と新しい Orthanc の ID が入る

#### Scenario: Orthanc が答えない

- **WHEN** 書き換えの要求が時間切れになる
- **THEN** `result` の行は `unknown` になり、AE の ACK が返る

### Requirement: 外から来た値の制御文字を見える形にして出す

受け口と BFF は、外から来た値（送り手の住所・MSH の値・理由の文）をログ・監査の記録の理由・ACK の文に出す前に、C0・DEL・C1・双方向の書式の字・行と段落の区切りを `\uXXXX` に置き換えなければならない（SHALL）。

#### Scenario: MSH-3 にエスケープシーケンス

- **WHEN** MSH-3 に ESC（U+001B）と `[31m` を含むメッセージを受ける
- **THEN** 受け口と BFF のログ、監査の記録、ACK の MSH-5 には ESC の字がそのまま出ず、`\u001B` の形か除いた形で出る
