# Spec Delta

## Purpose

画面から患者・検査の値を直す機能を定める。患者の属性と受付番号の訂正は IHE の PIR と同じく UID を保ち、それ以外の値の訂正は新しい UID の検査を作る。どちらも役割の確かめ・理由・再認証・監査の記録を通す。

## ADDED Requirements

### Requirement: 値の修正は属性の訂正と中身の訂正に分ける

BFF は、値の修正の要求を、属性の訂正（PatientID・PatientName・PatientBirthDate・PatientSex・AccessionNumber）と中身の訂正（それ以外の直せる値。StudyDate・StudyDescription）のどちらかとして受けなければならない（SHALL）。要求の種類と直す項目が合わない要求、1つの要求に2種類の項目を混ぜた要求は、Orthanc を呼ばずに 400 で断り、断ったことを監査の記録に残さなければならない（SHALL）。

#### Scenario: 2種類を混ぜた要求

- **WHEN** 一般の利用者が、氏名と検査日を1つの要求で直そうとする
- **THEN** BFF は 400 を返し、Orthanc は変わらず、監査の記録に `modify` の `denied` の行が残る

#### Scenario: 種類と項目が合わない

- **WHEN** 種類が `attribute` で、直す項目が StudyDescription の要求が来る
- **THEN** BFF は 400 を返し、Orthanc は変わらない

### Requirement: 値の修正は項目の有無と空の値を分ける

BFF は、要求に無い項目を変えてはならない（SHALL NOT）。空の文字列の項目は、タグを残したまま値を空にしなければならない（SHALL。PatientName・PatientBirthDate・PatientSex・AccessionNumber・StudyDate は Type 2）。患者 ID を空にする要求は断る（SHALL）。

#### Scenario: 空だった生年月日を前の値に戻す

- **WHEN** 生年月日が空の患者に生年月日を入れた後、生年月日を空の文字列にする属性の訂正を求める
- **THEN** 全部の画像の PatientBirthDate がタグを残したまま空になり、UID は変わらない

#### Scenario: 患者 ID を空にする

- **WHEN** 患者 ID を空の文字列にする要求が来る
- **THEN** BFF は 400 を返し、Orthanc は変わらない

### Requirement: 属性の訂正は UID を保つ

BFF は、属性の訂正で、検査の全部の画像の Study・Series・SOP Instance UID を保たなければならない（SHALL。IHE RAD TF-2 Rev. 23.0 の 4.14.4.1.3・4.13.4.3）。患者 ID を変える訂正は、付け替えの印を付けてから書き換え、書き換えた画像が揃ったことを確かめてから元の画像を名指しで消さなければならない（SHALL）。Orthanc に元の検査を消させてはならない（SHALL NOT。`KeepSource: false` を渡さない）。氏名・生年月日・性別の訂正は、同じ患者 ID の Orthanc の全部の検査に当てなければならない（SHALL。PS3.3 C.7.1.1）。患者 ID の付け替えと受付番号の訂正は、選んだ1つの検査だけに当てる（SHALL）。患者 ID の付け替えで替え先の患者が Orthanc にあるときは、氏名・生年月日・性別をその患者の値にそろえ、利用者が確かめの画面で入力した値がその患者の値と違えば、書き換えてはならない（SHALL NOT）。

#### Scenario: 氏名の訂正

- **WHEN** 一般の利用者が、理由を付け、再認証の後に、検査が2件ある患者の氏名を直す
- **THEN** 2件の検査の全部の画像の氏名が直した値になり、Study・Series・SOP Instance UID は変わらず、同じ UID の検査はそれぞれ1件だけになる

#### Scenario: 患者 ID の付け替え

- **WHEN** 管理者が、ある検査の患者 ID を、Orthanc にまだ無い患者 ID に付け替える
- **THEN** その検査の全部の画像が新しい患者 ID の検査に移り、UID は変わらず、元の患者 ID の下にその UID の画像は残らず、元の患者のほかの検査は変わらない

#### Scenario: 替え先の患者の値と入力が違う

- **WHEN** 付け替える先の患者 ID の患者が Orthanc にあり、利用者が入力した生年月日がその患者の値と違う
- **THEN** BFF は書き換えずに断り、Orthanc は変わらない

#### Scenario: 確かめの後に検査が変わった

- **WHEN** 利用者が確かめの画面を開いた後、実行の前に、HL7 の A40 がその検査を別の患者へ移す
- **THEN** BFF は書き換えずに 409 を返し、Orthanc は A40 の後のまま変わらない

#### Scenario: 書き換えの後の確かめが合わない

- **WHEN** 書き換えの後に読んだ画像の値の一部が、直した値になっていない
- **THEN** 結果は部分反映として監査の記録に残り、照らし合わせが済むまで、同じ検査への値の修正と HL7 の書き換えを断る

### Requirement: 中身の訂正は新しい UID の検査を作り、一般の要求では元を残す

BFF は、中身の訂正で、新しい Study・Series・SOP Instance UID の検査を作らなければならない（SHALL）。一般の役割の要求では、元の検査を残さなければならない（SHALL）。元を消す指定のある一般の要求は断る（SHALL）。

#### Scenario: 検査日の訂正

- **WHEN** 一般の利用者が、理由を付け、再認証の後に、ある検査の検査日を直す
- **THEN** 直した検査日の、新しい StudyInstanceUID の検査ができ、元の検査は残る

#### Scenario: 一般の要求で元を消す指定

- **WHEN** 一般の利用者が、元の検査を消す指定を付けて中身の訂正を求める
- **THEN** BFF は断り、Orthanc は変わらない

### Requirement: 値の修正は前と後の値を監査の記録に残す

BFF は、値の修正の Orthanc を呼ぶ前に、訂正の種類・直す項目ごとの前と後の値・StudyInstanceUID・理由・要求の ID を監査の記録（`modify`）に残し、残せなければ Orthanc を呼んではならない（SHALL NOT）。呼んだ後に、結果（成功・失敗・部分反映・結果不明）と、後の StudyInstanceUID を残さなければならない（SHALL）。属性の訂正では、前の値を元の値として残し、画像の写しを持たなくても前の値に戻せるようにする（SHALL）。

#### Scenario: 記録の内容

- **WHEN** 氏名を `YAMADA^TARO` から `YAMADA^JIRO` に直す属性の訂正が成功する
- **THEN** 監査の記録に、種類 `attribute`・PatientName の前と後の値・同じ StudyInstanceUID・理由・要求の ID の `request` の行と、成功の `result` の行が残る

#### Scenario: 記録できない

- **WHEN** 監査の記録に書けない
- **THEN** BFF は Orthanc を呼ばずに誤りを返す

### Requirement: 値の修正は役割・理由・再認証・CSRF を通す

BFF は、値の修正を一般と管理者にだけ許し（SHALL）、理由の無い要求・再認証の切れた要求・CSRF の確かめに通らない要求・画面のロック中の要求を断らなければならない（SHALL）。断った要求も監査の記録に残す（SHALL）。

#### Scenario: 理由が無い

- **WHEN** 理由を空にした値の修正の要求が来る
- **THEN** BFF は 400 を返し、Orthanc は変わらず、断ったことが監査の記録に残る

#### Scenario: 再認証が切れている

- **WHEN** 最後の再認証から `REAUTH_MINUTES` を過ぎた利用者が値の修正を求める
- **THEN** BFF は再認証を求めて断り、Orthanc は変わらない
