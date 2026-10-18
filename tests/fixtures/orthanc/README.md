# Orthanc の応答の見本

モックのバックエンド（`BACKEND_MOCK=true`）と試験に使う、Orthanc の REST と DICOMweb の応答の写し。
**合成の患者だけ**（PatientID が `JP-TEST-` で始まるもの。氏名・施設・医師はすべて架空）。実の患者のデータは入れない。

- 写した日：2026-10-18。Orthanc 1.x（REST の API の版は `rest/system.json` の `ApiVersion`）、DICOMweb のプラグインを有効にしたもの。
- 読むだけの要求で写した。ワークリストの試しの患者（`JP-TEST-WL` で始まるもの）は入れていない。
- 合成の画像は pydicom の UID の根（`1.2.826.0.1.3680043.8.498.`）で作ったもの。Orthanc の ID（`xxxxxxxx-xxxxxxxx-…`）は UID から決まる値で、そのまま残した。
  検査の label（`test-jp`）は、合成のデータに付けた目印で、そのまま残した。

## ファイルと、写した要求

| ファイル | 要求 |
|---|---|
| `rest/tools-find-study.json` | `POST /tools/find`、本文 `{"Level": "Study", "Query": {"PatientID": "JP-TEST-*"}, "Expand": true}` |
| `rest/studies/{id}.json` | `GET /studies/{id}`（上の検査のすべて） |
| `rest/series/{id}.json` | `GET /series/{id}`（上の検査のシリーズのすべて） |
| `rest/instances/{id}.json` | `GET /instances/{id}`（1つだけ） |
| `rest/instances/{id}/preview.png` | `GET /instances/{id}/preview`（サムネイル。1枚だけ。64×64 の合成のファントム） |
| `rest/system.json` | `GET /system` |
| `rest/statistics.json` | `GET /statistics`（下の置き換えの規則 4） |
| `dicom-web/studies.json` | `GET /dicom-web/studies?PatientID=JP-TEST-*`（QIDO-RS、`Accept: application/dicom+json`） |
| `dicom-web/studies/{StudyInstanceUID}/series.json` | `GET /dicom-web/studies/{StudyInstanceUID}/series`（上の1件目の検査） |

JSON は読みやすいように、キーを並べ替えて字下げした（値は変えていない。置き換えたものを除く）。

### BFF が実の画像サーバーに送る QIDO-RS の要求との違い

BFF の検査の検索（`src/lib/backend/http.ts`）は、次の形で求める：

```
GET /dicom-web/studies?limit=1000&includefield=00081030&includefield=00080061&includefield=00201206&includefield=00201208
Accept: application/dicom+json, application/json
```

`includefield` は、既定で返らないことがある項目（StudyDescription `00081030`・ModalitiesInStudy `00080061`・
NumberOfStudyRelatedSeries `00201206`・NumberOfStudyRelatedInstances `00201208`）を求めるもの。
上の `dicom-web/studies.json` は `includefield` 無しで写したので、**StudyDescription（`00081030`）が入っていない**
（モックの一覧の「検査の記述」の列は空になる）。合成の値を手で足すことはせず（写しと要求の対応が崩れるため）、
**段 2 で、BFF と同じ要求で写し直す**。

### 中継（WADO-RS）の見本

BFF の中継はビューアが画像を取る道（WADO-RS の読み取り）だけを通す（`docs/spec.md` の 3.2）。
WADO-RS の応答（`metadata`・frames など）の見本はまだ無いので、モックの中継は宛先を確かめたうえで 404 を返す。
ただしサムネイル（`thumbnail`・`rendered`）は、写しのある1枚（`rest/instances/{id}/preview.png`）の検査・シリーズ・画像に限り、その PNG を返す（段 2。一覧と詳細のパネルの代表のサムネイルの試験のため）。
上の QIDO-RS の写しは、画面の API（検索）のモックに使う。詳細のパネルのシリーズの並びは、QIDO-RS の写しが1件の検査の分しか無いので、
REST の写し（`rest/studies`・`rest/series`）から組み立てる（`src/lib/backend/mock.ts`）。

## 置き換えの規則

写す前に、次の値を例の値に置き換えた。見本を足すとき・取り直すときも、同じ規則で置き換える。

1. **URL の scheme・ホスト名・ポート**は、すべて `https://pacs.example.org` にする。パス（`/dicom-web/studies/…`）は残す。
   DICOMweb の RetrieveURL（`00081190`）などに、写した元のサーバーの名前が入るため。
2. **`/system` の施設を示しうる値**：`Name` は `Orthanc`、`DicomAet` は `ORTHANC`、`DatabaseServerIdentifier` は
   `00000000-00000000-00000000-00000000-00000000`、`UserMetadata` は空。データベースと保存のプラグインの値
   （`DatabaseBackendPlugin`・`StorageAreaPlugin`）は、値があれば `example-plugin` にする（今回はどちらも `null`）。
   既定のポート・性能の設定値は、公開されている Orthanc の既定と同じ種類の値なので残す（版の番号は規則 7）。
3. **`/instances/{id}` の `FileUuid`**（保存の場所の識別子）は `00000000-0000-0000-0000-000000000000` にする。
4. **`/statistics`** は、写した元のサーバー全体の件数ではなく、**この見本の合成の患者の件数**にする
   （患者 4・検査 8・シリーズ 10・画像 36）。容量は例の値（10 MiB）にする。
5. **サムネイルの PNG** は、補助の chunk（`tEXt`・`iTXt`・`zTXt`・`tIME`・`eXIf`）を落とす（今回は無かった）。
6. ホスト名・IP アドレス・AE タイトル・利用者名・パスワード・トークン・施設の名前・ファイルのパスが、
   上のほかに見つかったら、例の値（`pacs.example.org`・`192.0.2.10`・`ORTHANC`・空）に置き換え、この README に規則を足す。
7. **`/system` の版の値**（写した元の版を公開しないため）：`Version` は `"1.0.0"`、`ThirdPartyVersions` の値はすべて `"0.0.0"`（キーは残す）、`ThirdPartyPatches` は空の配列にする。
   この規則より前の写し（置き換える前の版の値）は、`main` の git の履歴に残っている。**履歴は書き換えない**（公開の履歴を書き換えると、ほかの人の写しと食い違うため）。これから写す見本と、この README の文に、写した元の版を書かない。

## 置き換えた後の確かめ

公開の前に、次の語が残っていないことを確かめる（社内の名前・私用の住所・秘密の変数の名前）。
語の一覧はこのリポジトリの外の決まりで持ち、ここには書かない。少なくとも次の形を見る。

```sh
# 例の名前でない URL・私用の IPv4 の住所・秘密らしい語
grep -rnoP "https?://(?!pacs\.example\.org)[^\"/ ]+" tests/fixtures/orthanc
grep -rnoE "\"(192\.168|172\.(1[6-9]|2[0-9]|3[01])|10)\.[0-9]+\.[0-9]+(\.[0-9]+)?" tests/fixtures/orthanc
grep -rniE "password|passwd|token|secret|apikey|api_key" tests/fixtures/orthanc --exclude=README.md
```

IPv4 の形は、DICOM の UID（数字と `.` の並び）と見分けるため、JSON の値の頭（`"` の直後）だけを見る。
3つとも何も出なければよい（2026-10-18 の写しでは、3つとも何も出なかった）。
