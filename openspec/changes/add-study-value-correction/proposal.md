# Proposal

## Why

段 6 の「患者・検査の値の修正」は、これまで、どの値を直しても新しい Study・Series・SOP Instance UID の検査を作る方針だった（`docs/spec.md` の 3.5）。一方、HL7 による患者情報の更新は、IHE の PIR に合わせて UID を保つ。同じ患者の属性を直すのに、HL7 の道は UID を保ち、画面の道は作り直すという、2つの方針が並んでいた。

IHE RAD TF-2 Rev. 23.0 の 4.14.4.1.3・4.16.4.2.3・4.17.4.2.3 は、患者の名前が変わっても同じ UID のまま違う患者名の画像が届くことを前提にしている。4.13.4.3 は、手続きの情報を Study Instance UID を鍵に更新するとしている。画面の訂正で UID を作り直すと、直した検査は、注文（RAD-13）・レポート・ほかの機器にある元の検査と結びつかなくなる。

2026-10-25 に、値の修正を2種類に分けることを決めた。患者の属性と受付番号の訂正は UID を保ち、それ以外の値の訂正は今のまま新しい UID を作る。この change は、その決定に沿って段 6 の値の修正を実装する段取りを決める。仕様（`docs/spec.md` の 3.5・3.6・6）は、この change と同じ PR で直した。コードは後の PR で変える。

## What Changes

- 値の修正を、**属性の訂正**（患者 ID・氏名・生年月日・性別・受付番号）と**中身の訂正**（検査日・検査名など、それ以外の値）に分ける。1つの要求に2種類を混ぜた要求は断る。
- 属性の訂正は UID を保つ。書き方は HL7 による患者情報の更新の部品（`Keep`・`Force`、付け替えの印、元の画像の名指しの削除、`OverwriteInstances` による置き換え、書き換えの後の確かめと照らし合わせ）を使い回す。
- 中身の訂正は、Orthanc の `/studies/{id}/modify` を `Keep` 無しで呼び、新しい UID の検査を作る。一般の要求では元の検査を必ず残す。
- 属性の訂正では、元の版は検査の中に残らない。元の値は、監査の記録（`modify`）の項目ごとの前の値として残す。書き換える前の画像の写しを施設の置き場に残すかは、実装の PR で決める（design.md の 3）。
- 画面の API に、値の修正の道（`POST /api/studies/{uid}/modify`）を足す。役割の確かめ・理由・再認証・CSRF・要求の ID・監査の記録は、書き込みの操作の共通の決まり（`docs/spec.md` の 3.5）に従う。

## Capabilities

### New Capabilities

- `study-value-correction`: 画面からの患者・検査の値の修正（2種類の分け方、UID の扱い、元の値の残し方、権限と監査の記録）

### Modified Capabilities

（なし。`hl7-patient-update` の要件は変えない。書き換えの部品を共有するだけ）

## Impact

- コード：`src/lib/hl7/apply.ts` の UID を保つ書き換え（印・名指しの削除・確かめ・照らし合わせ）を、HL7 と画面の両方から呼べる形に切り出す。`src/app/api/studies/[uid]/modify/route.ts`（新規）、`src/lib/auth/roles.ts`、`src/lib/backend/types.ts`・`http.ts`・`mock.ts`（新しい UID で作る書き換え）、画面の値の修正の窓（`src/components/studies`）
- 試験：単体（2種類の分け方・混ぜた要求・UID・監査の記録・役割・CSRF・再認証）、結合の試験（`tests/integration/orthanc.spec.ts`。本物の Orthanc で UID を保つ訂正と新しい UID の訂正）
- 文書：`docs/spec.md` の 3.5・3.6・6（この PR で直した）、`docs/guideline-mapping.md`（この PR で直した）、`docs/spec.md` の 2.2 の用語集（実装の PR で画面の呼び名を足す）
- 配る compose・施設の Orthanc：属性の訂正に要る設定（`OverwriteInstances: true`・`LuaScripts`・`UserMetadata`）の入れ方を実装の PR で決める（design.md の 4）
