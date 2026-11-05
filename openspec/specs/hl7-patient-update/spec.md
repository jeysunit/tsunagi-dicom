# hl7-patient-update Specification

## Purpose
HL7 v2.3.1 の患者の統合（ADT^A40）・患者の属性の更新（ADT^A08）・予約の知らせ（ORM^O01 の NW）を MLLP で受け、Orthanc の検査の患者と受付番号を、UID を保ったまま揃える。
受け口は開発の一式の内側だけで待ち受け、送り手の住所で絞る。解析・書き換え・監査の記録は BFF が行う。

## Requirements

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

受け口は、1 通が 1 MiB を超える、枠の外のバイトが来る、接続（または前の ACK）から 30 秒で枠が始まらない、枠の始まりから 30 秒で枠が終わらない、のどれかで接続を閉じなければならない（SHALL）。同時の接続は 8 までとする（SHALL）。

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

#### Scenario: まとめた知らせ

- **WHEN** 受け口が `{ "peer": "192.0.2.10", "event": "busy", "count": 3, "since": …, "until": … }` を送る
- **THEN** 200 が返り、監査の記録に数と期間つきの `busy` の行が残る。`count` の無い `busy` は 400

#### Scenario: 検証モードで書き込みを止めている

- **WHEN** `AUTH_MODE=dev` で `DEV_ALLOW_WRITE` が `true` でない BFF に、正しい token で A40 を送る
- **THEN** AE の ACK が返り、Orthanc は変わらない

### Requirement: 壊れたメッセージ・扱わないメッセージには AR を返す

BFF は、MSH が読めない、区切りが `|^~\&` でない、版が 2.3.1 でない、MSH-18 が空か `UNICODE UTF-8` でない、MSH-18 が空なのに ASCII でない字がある、UTF-8 として正しくない、知らないエスケープがある、値に制御文字がある、扱わない種類と構造の名前の組（design.md の 7）、ORM の ORC-1 が `NW`・`CA`・`DC`・`XO` のどれでもない、セグメントの数が合わない（PID が 2 つなど）、のどれかに当たるメッセージに、AR の ACK を返さなければならない（SHALL）。Orthanc は変えない（SHALL NOT）。エスケープは区切りで分けた後に戻し、戻した字を区切りとして読み直してはならない（SHALL NOT）。

#### Scenario: 形式が壊れたメッセージ

- **WHEN** MSH の無いメッセージを受ける
- **THEN** MSA-1 が AR の ACK が返り、Orthanc は変わらず、監査の記録に `rejected`（denied）の行が残る

#### Scenario: 扱わない種類

- **WHEN** ADT^A03 や、ORC-1 が `OC` の ORM を受ける
- **THEN** AR の ACK が返り、Orthanc は変わらない

#### Scenario: エスケープした区切りの字

- **WHEN** PID-5 の姓が `O\S\BRIEN` の A08 を受ける
- **THEN** 姓は `O^BRIEN` の 1 つの成分として読まれ、DICOM の PN の区切りにならないので、AE の ACK が返る（PN の成分に `^` は入れられない）

#### Scenario: 欄の繰り返しが多い

- **WHEN** PID-8 に `M~F` の繰り返しか `M&F` の下位成分がある A08、または MSH-10 が空のメッセージを受ける
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
書き換えは Orthanc の仕事として流し、仕事が終わった後に、全部の画像の UID の組（Study・Series・SOP）と値が予定どおりかを確かめてから成功とする（SHALL）。A08・ORM の書き換えも同じ。

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

BFF は ADT^A08 を受けたら、PID-3 の患者 ID の検査の、氏名・生年月日・性別を書き換えなければならない（SHALL）。PID の空の欄は変えない（SHALL NOT）。PID-8 が `U`（不明）のときは、DICOM の性別を空に書き換えなければならない（SHALL。docs/spec.md 3.5 の「HL7 による患者情報の更新」）。患者 ID と UID は変えない（SHALL NOT）。

#### Scenario: 性別を不明にする

- **WHEN** 性別が `M` の患者 ID `P000001` の検査があり、PID-8 が `U` の A08 を受ける
- **THEN** AA の ACK が返り、検査の性別が空になり、患者 ID・UID は変わらない

#### Scenario: 氏名だけを直す

- **WHEN** 患者 ID `P000001` の検査があり、氏名だけを変えた A08 を受ける
- **THEN** AA の ACK が返り、検査の氏名が替わり、患者 ID・生年月日・UID は変わらない

#### Scenario: 元の検査を消さない

- **WHEN** 患者 ID `P000001` の画像 4 枚の検査があり、氏名を変えた A08 を受ける
- **THEN** BFF は Orthanc に `KeepSource: false` を渡さず、書き換えの後も同じ UID の画像 4 枚が新しい氏名で 1 件の検査に残る

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

#### Scenario: 仕事が途中で失敗した

- **WHEN** 書き換えの仕事が、検査の画像の一部を書き換えた後に `Failure` になる
- **THEN** `result` は `partial` になって AE の ACK が返り、管理者が解くまで次のメッセージにも AE を返す。全部の画像が前の値のままなら `failed` になり、次のメッセージは止めない

#### Scenario: 途中で止まったメッセージの送り直し

- **WHEN** BFF が `received` の行を残した後、`ack` の行を残す前に止まり、起き直した後に同じメッセージを受ける
- **THEN** そのメッセージの書き換えを照らして解けたら、`ack` を AE（途中で止まった）で閉じ、送り直しには AE を返す。Orthanc は呼び直さない

### Requirement: 外から来た値の制御文字を見える形にして出す

受け口と BFF は、外から来た値（送り手の住所・MSH の値・理由の文）をログ・監査の記録の理由・ACK の文に出す前に、C0・DEL・C1・双方向の書式の字・行と段落の区切りを `\uXXXX` に置き換えなければならない（SHALL）。

#### Scenario: MSH-3 にエスケープシーケンス

- **WHEN** MSH-3 に ESC（U+001B）と `[31m` を含むメッセージを受ける
- **THEN** 受け口と BFF のログ、監査の記録、ACK の MSH-5 には ESC の字がそのまま出ず、`\u001B` の形か除いた形で出る

### Requirement: ORM の CA・DC は検査を消さずに受付番号を外し、XO は NW と同じに扱う

BFF は ORM^O01 の ORC-1 が `CA`（取消）か `DC`（中止）なら、ZDS-1 の Study Instance UID の検査の受付番号を空にしなければならない（SHALL。IHE RAD TF-2 4.13）。検査と画像は消してはならない（SHALL NOT）。検査の患者 ID が PID-3 と違うとき、または検査の受付番号が OBR-18 と違うときは、書き換えずに AE を返す（SHALL）。受付番号がすでに空なら書き換えない。`XO`（変更）は `NW` と同じ規則で受付番号を入れる。

#### Scenario: 予約の取消

- **WHEN** 受付番号 `RE1` の検査に、同じ患者 ID・同じ StudyInstanceUID・OBR-18 が `RE1` の CA を受ける
- **THEN** AA の ACK が返り、検査と画像は残り、受付番号が空になる。UID は変わらない

#### Scenario: 受付番号が違う

- **WHEN** 受付番号 `RE1` の検査に、OBR-18 が `RE9` の CA を受ける
- **THEN** AE の ACK が返り、検査は変わらない

### Requirement: 照合の後に仮の患者 ID で届いた画像を統合した先の患者に書き換える

BFF は、A40 と ORM を受理（AA）したときに、旧い患者 ID と統合した先の患者 ID・その A40 で書き換えた検査の StudyInstanceUID・統合の前の氏名と生年月日と性別・ORM の StudyInstanceUID と受付番号と ORC-1 を、監査の記録の `ack` の行に覚えなければならない（SHALL）。覚えは受理から 24 時間だけ使う（SHALL）。
受け口は BFF の `/api/hl7/sweep`（`/api/hl7/messages` と同じ token）を定期に呼び、BFF はメッセージと同じ列で、覚えのある旧い患者 ID の検査のうち、StudyInstanceUID が覚えにあり、届き終えた（Orthanc の `IsStable`）ものを、A40 と同じ書き方（UID を保ち、元を残して書き換え、書き換えた画像を確かめてから元の画像だけを名指しで消し、監査の記録を通し、仕事の終わりと全画像を確かめる）で統合した先の患者に書き換えなければならない（SHALL。IHE PIR の Case 6）。受付番号は、その検査の最後の ORM の値（CA・DC なら空）にする。
BFF は Orthanc に元の検査を消させてはならない（`KeepSource: false` を渡さない。SHALL NOT）。書き換えの最中に元の検査へ届いた画像は消さずに残し、部分反映として止めなければならない（SHALL）。
覚えの StudyInstanceUID は、最初の段の A40 で書き換えた検査と、最初の段の先の患者の ORM（その患者がさらに統合される前に受理したもの）の検査に限る（SHALL）。A40 で書き換えた検査の StudyInstanceUID は、統合した先にその UID の検査が残っているときだけ使う（SHALL）。
覚えに無い StudyInstanceUID の検査、画像の患者 ID が旧い患者 ID と違う検査、統合の前と氏名・生年月日・性別の食い違う画像、統合した先の検査にすでにある画像の送り直し、同じ StudyInstanceUID の検査が別の患者にあるとき、同じ旧い患者 ID から 2 つ以上の先がある・統合が輪になっているときは、書き換えてはならない（SHALL NOT）。結果の分からない書き換えがあるときは、何も書き換えない（SHALL NOT）。
覚えを持つ監査の記録の行は、使う前に鍵つきの値（HMAC）と前の行とのつなぎを確かめなければならない（SHALL）。合わない行が 1 つでもあれば、見回りは何も書き換えず、メッセージは AE を返す（SHALL）。

#### Scenario: 統合した検査に後から届いた画像

- **WHEN** 仮の患者 ID `ER2026102400` の検査を A40 で `P000001` に統合し、ORM の NW で受付番号 `RE1` を入れた後に、同じ StudyInstanceUID の画像が仮の患者 ID で届く
- **THEN** 次の見回りで、その画像は `P000001`・`RE1` に書き換わり、元の検査とまとまって 1 件になる。UID は変わらない

#### Scenario: 受け口が止まっていた間に届いた画像

- **WHEN** 受け口が止まっている間に、統合した検査の画像が仮の患者 ID で届き、その後に受け口が起き直す
- **THEN** 起き直した後の最初の見回りで、その画像は統合した先の患者に書き換わる

#### Scenario: 同じ仮の患者 ID の別の撮影

- **WHEN** 統合の後に、同じ仮の患者 ID で、StudyInstanceUID の違う検査が届く
- **THEN** その検査は書き換わらない

#### Scenario: 期限の外

- **WHEN** A40 の受理から 24 時間を過ぎた後に、統合した検査の画像が仮の患者 ID で届く
- **THEN** その画像は書き換わらない

#### Scenario: 統合が 2 段

- **WHEN** `ER2026102400` を `P000001` に、続けて `P000001` を `P000002` に統合した後に、統合した検査の画像が `ER2026102400` で届く
- **THEN** その画像は `P000002` に書き換わる

#### Scenario: 統合の先が決まらない

- **WHEN** `ER2026102400` を `P000001` に統合した後に、`ER2026102400` を `P000003` に統合する A40 も受けている
- **THEN** `ER2026102400` で届いた画像は書き換わらない

#### Scenario: 人が誤った統合を書き戻した

- **WHEN** `ER2026102400` の検査を A40 で `P000001` に統合した後に、人が Orthanc でその検査を UID を保ったまま `ER2026102400` に書き戻す
- **THEN** 次の見回りは、その検査を `P000001` に書き換えない

#### Scenario: 書き換えの最中に届いた画像

- **WHEN** 見回りが仮の患者 ID の検査を書き換えている最中に、同じ検査に仮の患者 ID の画像が REST で届く
- **THEN** 届いた画像は仮の患者 ID の検査に残り、見回りは部分反映として止まる

### Requirement: 患者 ID の変わる書き換えの間は、同じ StudyInstanceUID の C-STORE を Orthanc に断らせる

A40 と見回りの書き換えの前に、元の検査に付け替えの印（Orthanc の利用者のメタデータ `TsunagiLock`。値は期限の UNIX 秒）を付け、元の画像を消し終えたら・失敗したら外す。Orthanc の Lua は、期限の切れていない印のある検査と同じ StudyInstanceUID の C-STORE に `0xA700` を返す。元を消す前に、書き換えた画像の `ModifiedFrom` が元の画像の ID と同じかを確かめる。

#### Scenario: 書き換えの最中の C-STORE

- **WHEN** A40 か見回りが仮の患者 ID の検査を書き換えている最中に、同じ StudyInstanceUID の画像が C-STORE で届く
- **THEN** Orthanc は送り手に `0xA700` を返して保存せず、書き換えが終わって印が外れた後の送り直しは保存する

#### Scenario: 印を付けられない

- **WHEN** Orthanc に `UserMetadata` の `TsunagiLock` が無く、印を付けられない
- **THEN** BFF は患者 ID を書き換えず、A40 に AE を返す

#### Scenario: 書き換えた画像が置き換わった

- **WHEN** 書き換えの仕事が写した後、元を消す前に、統合した先の患者 ID で同じ UID の別の画像が REST で届き、写しが置き換わる
- **THEN** BFF は元の画像を消さず、部分反映として止める

#### Scenario: 覚えの行が書き換えられた

- **WHEN** 監査の記録の `ack` の行の覚えが、鍵を持たない者に書き換えられる、または書き足される
- **THEN** 見回りは何も書き換えず、次の A40 は AE になる
