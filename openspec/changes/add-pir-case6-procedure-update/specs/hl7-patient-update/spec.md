# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
受け口は BFF の `/api/hl7/sweep`（`/api/hl7/messages` と同じ token）を定期に呼び、BFF はメッセージと同じ列で、覚えのある旧い患者 ID の検査のうち、StudyInstanceUID が覚えにあり、届き終えた（Orthanc の `IsStable`）ものを、A40 と同じ書き方（UID を保ち、元を消し、監査の記録を通し、仕事の終わりと全画像を確かめる）で統合した先の患者に書き換えなければならない（SHALL。IHE PIR の Case 6）。受付番号は、その検査の最後の ORM の値（CA・DC なら空）にする。
覚えの StudyInstanceUID は、最初の段の A40 で書き換えた検査と、最初の段の先の患者の ORM（その患者がさらに統合される前に受理したもの）の検査に限る（SHALL）。
覚えに無い StudyInstanceUID の検査、統合の前と氏名・生年月日・性別の食い違う画像、統合した先の検査にすでにある画像の送り直し、同じ StudyInstanceUID の検査が別の患者にあるとき、同じ旧い患者 ID から 2 つ以上の先がある・統合が輪になっているときは、書き換えてはならない（SHALL NOT）。結果の分からない書き換えがあるときは、何も書き換えない（SHALL NOT）。

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
