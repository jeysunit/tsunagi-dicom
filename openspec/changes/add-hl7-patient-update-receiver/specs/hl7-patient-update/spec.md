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

#### Scenario: 同時の接続が多すぎる

- **WHEN** 許可した送り手から 9 本目の接続が来る
- **THEN** 受け口はその接続をすぐ閉じ、1 分にまとめた `busy` の知らせ（数つき）が監査の記録に残る

#### Scenario: BFF に知らせを届けられない

- **WHEN** 断った接続の知らせを、送り直しても BFF に届けられない
- **THEN** 受け口はログに残し、次に届いた知らせと一緒に、落とした数と期間を `dropped` として送る

#### Scenario: 一覧が空

- **WHEN** `HL7_ALLOWED_SOURCES` を設定せずに受け口を起こす
- **THEN** 受け口は誤りを出して終わり、待ち受けない

### Requirement: 受け口はメッセージの大きさと時間に上限を置く

受け口は、1 通が 1 MiB を超える、枠の外のバイトが来る、接続から 30 秒で 1 通を読み終えない、のどれかで接続を閉じなければならない（SHALL）。同時の接続は 8 までとする（SHALL）。

#### Scenario: 大きすぎるメッセージ

- **WHEN** 許可した送り手が、枠の終わりの無いまま 1 MiB を超えるバイトを送る
- **THEN** 受け口は ACK を返さずに接続を閉じ、BFF には HL7 の本文を渡さず `oversize` の知らせだけを送る

#### Scenario: IPv4 を写した IPv6 の住所

- **WHEN** 許可の一覧に `127.0.0.1` だけを書き、相手の住所が `::ffff:127.0.0.1` の接続が来る
- **THEN** 受け口は `127.0.0.1` として比べ、通す

#### Scenario: 名前を引けない

- **WHEN** 許可の一覧の名前を 2 秒で引けない
- **THEN** 受け口はその接続を断る

#### Scenario: BFF が答えない

- **WHEN** BFF が 60 秒で答えないか、200 でない答えを返す
- **THEN** 受け口は ACK を返さずに接続を閉じる

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

#### Scenario: 大きすぎる本文

- **WHEN** `content-length` を偽って 2 MiB を超える本文を送るか、base64 を戻すと 1 MiB を超える本文を送る
- **THEN** 400 が返り、Orthanc は呼ばれない

#### Scenario: 検証モードで書き込みを止めている

- **WHEN** `AUTH_MODE=dev` で `DEV_ALLOW_WRITE` が `true` でない BFF に、正しい token で A40 を送る
- **THEN** AE の ACK が返り、Orthanc は変わらない

### Requirement: 壊れたメッセージ・扱わないメッセージには AR を返す

BFF は、MSH が読めない、区切りが `|^~\&` でない、版が 2.3.1 でない、MSH-18 が空か `UNICODE UTF-8` でない、MSH-18 が空なのに ASCII でない字がある、UTF-8 として正しくない、知らないエスケープがある、値に制御文字がある、扱わない種類と構造の名前の組（design.md の 7）、セグメントの数が合わない（PID が 2 つなど）、のどれかに当たるメッセージに、AR の ACK を返さなければならない（SHALL）。Orthanc は変えない（SHALL NOT）。エスケープは区切りで分けた後に戻し、戻した字を区切りとして読み直してはならない（SHALL NOT）。

#### Scenario: 形式が壊れたメッセージ

- **WHEN** MSH の無いメッセージを受ける
- **THEN** MSA-1 が AR の ACK が返り、Orthanc は変わらず、監査の記録に `rejected`（denied）の行が残る

#### Scenario: 扱わない種類

- **WHEN** ADT^A03 や、ORC-1 が CA の ORM を受ける
- **THEN** AR の ACK が返り、Orthanc は変わらない

#### Scenario: エスケープした区切りの字

- **WHEN** PID-5 の姓が `O\S\BRIEN` の A08 を受ける
- **THEN** 姓は `O^BRIEN` の 1 つの成分として読まれ、DICOM の PN の区切りにならないので、AE の ACK が返る（PN の成分に `^` は入れられない）

#### Scenario: 欄の繰り返しが多い

- **WHEN** PID-8 に `M~F` の繰り返しがある A08、または MSH-10 が空のメッセージを受ける
- **THEN** AR の ACK が返り、Orthanc は変わらない

#### Scenario: 氏名のグループが長すぎる

- **WHEN** 英字のグループが、並べ替えた後に区切りを含めて 65 文字になる A08 を受ける
- **THEN** AE の ACK が返り、Orthanc は変わらない

#### Scenario: PID が 2 つ

- **WHEN** PID セグメントが 2 つある A40 を受ける
- **THEN** AR の ACK が返り、Orthanc は変わらない

#### Scenario: MSH-18 が空で日本語がある

- **WHEN** MSH-18 が空で、PID-5 に漢字がある A08 を受ける
- **THEN** AR の ACK が返る

#### Scenario: 値に制御文字

- **WHEN** PID-5 に `\X1B\` のエスケープや ESC の字を含むメッセージを受ける
- **THEN** AR の ACK が返り、理由の文と監査の記録の理由では、制御文字が `\u001B` の形で出る

### Requirement: A40 で旧い患者の検査を新しい患者 ID に書き換え、UID を保つ

BFF は ADT^A40 を受けたら、MRG-1 の旧い患者 ID の検査を全部、PID の患者 ID・氏名・生年月日・性別に書き換えなければならない（SHALL）。Study・Series・SOP の各 UID は保ち（SHALL）、元の検査は Orthanc に残してはならない（SHALL NOT）。
書き換えは Orthanc の仕事として流し、仕事が終わった後に、全部の画像の SOP Instance UID と値が予定どおりかを確かめてから成功とする（SHALL）。A08・ORM の書き換えも同じ。

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

- **WHEN** PID-3 の患者 ID の検査が Orthanc にすでにあり、PID-5 が替え先と同じ氏名で、PID-7 が空の A40 を受ける
- **THEN** AA の ACK が返り、書き換えた検査の生年月日は替え先の患者のいまの値になる。替え先の患者の検査は変わらない

#### Scenario: 替え先の患者と属性が違う

- **WHEN** PID-3 の患者 ID の検査が Orthanc にすでにあり、PID-7 がその患者のいまの生年月日と違う A40 を受ける
- **THEN** AE の ACK が返り、旧い患者の検査も替え先の患者の検査も変わらない

#### Scenario: 発番元の違う患者 ID

- **WHEN** PID-3 か MRG-1 の発番元（CX の 4 つめの namespace ID）が `HL7_PATIENT_ID_ISSUER` と違う A40、または CX の 4 つめに universal ID のある A40 を受ける
- **THEN** AE の ACK が返り、Orthanc は変わらない

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

#### Scenario: 書き換えた後に記録できない

- **WHEN** Orthanc の書き換えが成功した後に、`result` の行の追記が失敗する
- **THEN** AE の ACK が返り、その書き換えは結果の分からない書き換えとして残る（次のメッセージの前に照らす）

#### Scenario: Orthanc が答えない

- **WHEN** 書き換えの要求が時間切れになる
- **THEN** `result` の行は `unknown` になり、AE の ACK が返る

### Requirement: 同じメッセージを重ねず、結果の分からない書き換えを照らす

BFF は、解析を通ったメッセージを Orthanc を読む前に `received` として記録し（SHALL）、同じ送り手（MSH-3・MSH-4）と同じ MSH-10 のメッセージを直近 7 日に受けていれば、Orthanc を呼ばずに前と同じ ACK のコードを返さなければならない（SHALL）。本文が違えば AR を返す（SHALL）。
新しいメッセージを処理する前に、解いていない書き換えを Orthanc の仕事の状態と画像ごとの値で照らし、仕事が終わったと読めないものが 1 つでもあれば、Orthanc を変えずに AE を返さなければならない（SHALL）。仕事の ID の無い書き換えと、画像の一部だけが書き換わった書き換えは、自動で解いてはならない（SHALL NOT）。

#### Scenario: 同じメッセージの送り直し

- **WHEN** AA を返した A08 と同じ MSH-3・MSH-4・MSH-10・本文の A08 を、別の A08 で氏名を直した後にもう一度受ける
- **THEN** 前と同じ AA が返り、Orthanc は呼ばれず、氏名は後の A08 の値のまま

#### Scenario: 同じ MSH-10 で中身が違う

- **WHEN** 前に受けたメッセージと同じ MSH-3・MSH-4・MSH-10 で、本文の違うメッセージを受ける
- **THEN** AR の ACK が返り、Orthanc は変わらない

#### Scenario: 仕事の終わりを待ちきれなかった書き換えを照らす

- **WHEN** 前の A40 の書き換えの仕事が 120 秒で終わらず `unknown` になり、その後 Orthanc で `Success` になって、全部の画像が予定の値になっている。そこへ次のメッセージを受ける
- **THEN** BFF は `reconcile` の行を足してその書き換えを成功として解き、次のメッセージを処理する

#### Scenario: 仕事がまだ動いている

- **WHEN** 解いていない書き換えの仕事が Orthanc でまだ `Running` のときに、次のメッセージを受ける
- **THEN** AE の ACK が返り、Orthanc は変わらない

#### Scenario: 仕事の ID が無い書き換え

- **WHEN** 書き換えの要求を送った後に答えが来ず、仕事の ID が分からない。そこへ次のメッセージを受ける
- **THEN** AE の ACK が返り、Orthanc は変わらない。管理者が `/api/hl7/resolve` で確かめた内容を書くと解け、次のメッセージは処理される

#### Scenario: 画像の一部だけが書き換わった

- **WHEN** 書き換えの仕事が `Success` になったが、検査の画像のうち 1 枚の PatientID が前の値のまま
- **THEN** `result` は `partial` になって AE の ACK が返り、管理者が解くまで次のメッセージにも AE を返す

#### Scenario: 途中で止まったメッセージの送り直し

- **WHEN** BFF が `received` の行を残した後、`ack` の行を残す前に止まり、起き直した後に同じメッセージを受ける
- **THEN** そのメッセージの書き換えを照らして解けたら、`ack` を AE（途中で止まった）で閉じ、送り直しには AE を返す。Orthanc は呼び直さない

### Requirement: 外から来た値の制御文字を見える形にして出す

受け口と BFF は、外から来た値（送り手の住所・MSH の値・理由の文）をログ・監査の記録の理由・ACK の文に出す前に、C0・DEL・C1・双方向の書式の字・行と段落の区切りを `\uXXXX` に置き換えなければならない（SHALL）。

#### Scenario: MSH-3 にエスケープシーケンス

- **WHEN** MSH-3 に ESC（U+001B）と `[31m` を含むメッセージを受ける
- **THEN** 受け口と BFF のログ、監査の記録、ACK の MSH-5 には ESC の字がそのまま出ず、`\u001B` の形か除いた形で出る
