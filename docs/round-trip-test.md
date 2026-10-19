# 往復の試験の手順（受け取る → 見る → 送り返す）

段 4（[`spec.md`](spec.md) の 3.3・3.4）の機能を、実の Orthanc と、検査装置の試験用のソフト [dicom-test-generator](https://github.com/jeysunit/dicom-test-generator) で確かめる手順。
クラウドの開発環境はモックだけで試す（`tests/unit/pacs-routes.test.ts`・`tests/e2e/pacs.spec.ts`・`tests/e2e/local-auth.spec.ts`）。CI では、モックの試験に加えて、この手順の 1〜7・9 を、検査装置の試験用のソフトの代わりに DCMTK で、試験の中で立てた Orthanc のコンテナに対して流す（[`integration-test.md`](integration-test.md)）。この手順は、施設の環境に近い Orthanc と検査装置の試験用のソフトで確かめるときに人が行い、結果を PR に書く（8 は CI では流さない）。

> **架空の患者だけで試す。** 実の患者のデータは使わない。試しの環境（架空の患者だけ）では、読む資格情報と書く資格情報を分けることを勧める（必須ではない。[`security-and-maintenance.md`](security-and-maintenance.md) の 4.1）。

## 流れ

```mermaid
flowchart LR
  classDef box fill:#ffffff,stroke:#0969da,stroke-width:2px,color:#1f2328

  DTG["dicom-test-generator<br/>送る側（検査装置のふり）<br/>受け取る側（Storage SCP）"]:::box
  OR[("Orthanc（試験用）")]:::box
  TD["tsunagi-dicom"]:::box

  DTG -->|"1 C-STORE で送る"| OR
  TD -->|"2 受け取りの記録を読む"| OR
  TD -->|"3 C-ECHO を求める"| OR
  OR -->|"3 C-ECHO"| DTG
  TD -->|"4 送るを求める"| OR
  OR -->|"4 C-STORE で送り返す"| DTG
```

## 用意

1. **Orthanc**：DICOMweb のプラグインを有効にする。dicom-test-generator の受け取る側を、送り先の機器として登録する（例：Orthanc の設定の `DicomModalities` に `"dtg": ["DTG_SCP", "192.0.2.20", 11112]`。名前・AE タイトル・住所は環境の値にする）。dicom-test-generator からの C-STORE を受けられるようにする（受け元の確かめは Orthanc の設定で、施設の決まりに従う）。
   - REST で機器を足したときは、Orthanc の記憶の中だけにあり、再起動で消える（`DicomModalitiesInDatabase` を `true` にすると残る）。
2. **dicom-test-generator**：`config/app_config.yaml` の `storage_scp:` を `enabled: true` にして、受け取る側を起こす（`python -m app.cli scp start`）。既定は手元（127.0.0.1）だけで待ち受けるので、Orthanc から届く住所で待ち受けるように設定する。C-ECHO には Success を返す。
3. **tsunagi-dicom**：`AUTH_MODE=local`、`BACKEND_MOCK=false`、`BACKEND_ORTHANC_URL`（Orthanc の REST）と `BACKEND_DICOMWEB_URL`（Orthanc の DICOMweb のプラグイン）を設定する。書く資格情報を分けるときは `BACKEND_WRITE_USERNAME`・`BACKEND_WRITE_PASSWORD_FILE` も渡す。管理者か技師の利用者でログインする。
4. 試す前に、管理者で `/api/audit/verify` を開き、`checked`（記録の行の数）を控える。

## 手順と、確かめること

| # | すること | 期待すること | 控えること |
|---|---|---|---|
| 1 | dicom-test-generator から Orthanc へ、架空の患者の検査を1件送る | dicom-test-generator の側で送れたと出る | 送った検査の患者 ID・StudyInstanceUID・画像の数・送った側の AE タイトル |
| 2 | tsunagi-dicom の「受け取り」を開く | いちばん上の行に、送った検査が出る。時刻・送ってきた機器（1 の AE タイトル）・画像の数が合う | 出た時刻と Orthanc のサーバーの時計のずれ。送ってきた機器が空なら、Orthanc の画像のメタデータの名前（`RemoteAET`）を確かめる |
| 3 | 「機器」を開き、`dtg` の「確かめる」を押す | 「つながった」と出る。dicom-test-generator を止めて押すと「つながらない」と出る | Orthanc の C-ECHO の答えの時間 |
| 4 | 「検査」で 1 の検査を選び、詳細のパネルの「送る」から `dtg` を選んで送る | 確かめの画面に検査と送り先が出る。送ると「送る順を待っている」→「送っている」→「送った」と進む | Orthanc の仕事の ID（`/jobs` に出る）・かかった時間 |
| 5 | dicom-test-generator の受け取る側の記録を見る | 1 と同じ検査（同じ StudyInstanceUID・画像の数）が届いている | 届いた画像の数 |
| 6 | dicom-test-generator を止めてから、4 をもう一度流す | 「送れなかった」と、Orthanc の誤りの文言が出る | 出た誤りの番号と文言 |
| 7 | **受けた後に答えが失われたとき**：tsunagi-dicom と Orthanc の間の入口（リバースプロキシ）の答えを待つ時間を短くして（例：1 秒）、4 を流す | Orthanc は仕事を受けて送り先へ送るが、画面は「結果が分からない」と要求の ID を出し、「送る」は押せない。新しく送ろうとしても、同じ検査・同じ送り先は断られる | Orthanc の `/jobs` に仕事ができたか、dicom-test-generator に届いたか。届いていれば、管理者が「送り先で確かめた内容」を書いて「届いていた」を押し、記録に `reconcile` の行が足されること。入口の待つ時間は元に戻す |
| 8 | **監査の記録が書けないとき**：試しの環境だけで、tsunagi-dicom の `/data` を読み取りだけにしてから、4 を流す（施設の本番の環境では行わない） | 「求めた」を記録できないので、Orthanc を呼ばずに誤りになる（Orthanc の `/jobs` に仕事ができない・dicom-test-generator に届かない） | Orthanc の `/jobs` に新しい仕事が無いこと。`/data` を戻してから、9 で記録のつなぎが壊れていないこと |
| 9 | 管理者で `/api/audit/verify` を開く | `ok` が `true`。`checked` が 4 の手順の前より増えている | 増えた行の数。送るの記録が、要求の ID で「求めた」「結果」「終わり」の3行（7 の送信は「求めた」「結果（unknown）」「照らした」）につながっていること |

## 実測で決めること（段 4 の残り）

### 結合の試験で測った結果（2026-10-20）

結合の試験（[`integration-test.md`](integration-test.md)）で、`orthancteam/orthanc:26.9.1`（Orthanc 1.13.0、REST の API の版 31、DICOMweb のプラグイン 1.24）を相手に測った。送る側は DCMTK 3.6.9 の storescu、送り先は storescp。試験は CI で毎回流れ、測った値は `test-results/integration/observations.json` と CI の記録の `[itest-observation]` の行に出る。

| 項目 | 測った結果 | モックの見本・BFF の前提との違い |
|---|---|---|
| 画像のメタデータ（`/instances/{id}/metadata?expand`）の名前 | `CalledAET`・`IndexInSeries`・`MainDicomTagsSignature`・`Origin`・`PixelDataOffset`・`ReceptionDate`・`RemoteAET`・`RemoteIP`・`SopClassUid`・`TransferSyntax` | 見本（`made/instance-metadata.json`）の 5 つ（`CalledAET`・`Origin`・`ReceptionDate`・`RemoteAET`・`TransferSyntax`）は名前も形も合う。名前は `RemoteAET`（BFF が先に読む名前）。見本に無い名前は BFF が読まないので、違いにならない |
| メタデータの値 | C-STORE で受けた画像は `Origin` が `DicomProtocol`、`RemoteAET` が送ってきた側の AE タイトル、`CalledAET` が Orthanc の AE タイトル。`ReceptionDate` は `YYYYMMDDTHHMMSS` | 見本と合う |
| `/changes` の `Date` と `ReceptionDate` の時間帯 | UTC（時間帯の印なし）。Orthanc のコンテナの時間帯を `Asia/Tokyo`（`+0900`）にしても UTC のまま | [`spec.md`](spec.md) の 3.3 の「Date は UTC」と合う。いまの BFF の `receivedAt` は印なしで返り、頁は UTC の時刻をそのまま出す（3.3 の、`Z` つきで返して `TZ` に直す直しは別の PR で行う。試験は印なしと `Z` つきの両方を受ける） |
| `/changes?last` | 最後の変更 1 件を返す（名前は `Changes`・`Done`・`First`・`Last`。`Done` は `true`） | BFF が使う `Last` は合う。`First` は見本に無いが、BFF は読まない |
| `/changes` が 1 回に返す数 | `since=0&limit=1000` で、全部の 155 件を 1 回で返した（`Done` は `true`）。100 件では切り詰めない | BFF は 100 件ずつ求めて `Last` から続けて読むので、どちらでも抜けない。1000 件を超えたときの上限は測っていない |
| `/studies/{id}/series` | シリーズごとに `Instances`（画像の ID の並び）を返す | BFF の読み方の前提と合う |
| 送るの非同期の答え（`POST /modalities/{id}/store`、`Synchronous: false`） | `ID` と `Path` | BFF は `ID` だけを読む。合う |
| 送るの仕事の状態の移り方 | 画像 120 枚の送るで `Running` → `Success`（空いた Orthanc では `Pending` を読めなかった） | モックは `Pending` → `Running` → `Success`。実では `Pending` を飛ばすことがあるが、画面は `Pending` が無くても終わりまで出す（試験の 4 で確かめた） |
| 仕事の JSON の名前 | `CompletionTime`・`Content`・`CreationTime`・`EffectiveRuntime`・`ErrorCode`・`ErrorDescription`・`ErrorDetails`・`ID`・`Priority`・`Progress`・`State`・`Timestamp`・`Type`。`Content` は `Description`・`FailedInstancesCount`・`InstancesCount`・`LocalAet`・`ParentResources`・`RemoteAet`・`Resources` | BFF が読む名前（`ID`・`State`・`Progress`・`ErrorCode`・`ErrorDescription`・`CreationTime`・`CompletionTime`）はある |
| 成功のとき | `ErrorCode` 0、`ErrorDescription` は `Success` | モックと合う |
| 送り先が止まっているとき | `State` が `Failure`、`ErrorCode` 9、`ErrorDescription` は `Error in the network protocol`、`ErrorDetails` に送り先へつなげなかった理由（送り先の名前を引けない） | モックの見本（`ErrorCode` 9・`Error in the network protocol`）と合う。BFF は `ErrorDetails` を画面に返さない |
| C-ECHO が通らないとき | Orthanc は 500 と、誤りの JSON（`Details`・`HttpError`・`HttpStatus`・`Message`・`Method`・`OrthancError`・`OrthancStatus`・`Uri`）を返す | BFF の前提（500 を「つながらない」と読む）と合う |
| 書き出し（`/studies/{id}/archive`） | 画像の数だけの DICOM のファイルの ZIP（患者・検査・シリーズのフォルダの下）。ほかのファイルは無い | 合う |
| 受けた後に答えが失われたとき（上の手順 7） | 入口が 504 を返しても、Orthanc は仕事を作って送り先へ送る | BFF の結果不明の扱い（[`spec.md`](spec.md) の 3.5）の前提と合う |

### まだ測っていないこと

- 送り先の機器の数が多いとき・受け取りの記録が多いときの、画面の答えの時間。
- `/changes` が 1 回に返す数の上限（1000 件を超えたとき）。
- 施設の環境に近い Orthanc（データベースの差し替え・入口のリバースプロキシ・TLS）での、上の結果の違い。

結果は、段 4 の PR に書く（どの Orthanc の版で、何が期待どおりで、何が違ったか）。施設の内部の名前・住所は書かない。
