# Design

## Context

動機は proposal.md の Why。この設計に効くいまの形と、決まっていることは次のとおり。

- 書き込みは、決めた操作ごとの Orthanc の REST だけを BFF から呼ぶ。Orthanc を呼ぶ前に「求めた」ことを監査の記録に残し、記録できなければ呼ばない（`docs/spec.md` の 3.5）。
- 監査の記録は BFF のデータベース（SQLite）の 1 本のつなぎで、行は鍵つきの HMAC でつなぐ。鍵は `SESSION_SECRET` から導く（`docs/adr/0001-audit-chain-mac.md`）。
- 配る compose では、tsunagi-dicom は `backend`（内部）と `web` のネットワーク、Orthanc は `backend` と `dicom` のネットワークに入る。開発の一式では ris-emulator・DTG が `dicom` に入る。
- 承認者の決定（2026-10-24 19:33、PIR の提案の 5.2）：受け方は HL7 v2 の受け口（A）、Orthanc を書き換える（A1）、HL7 v2.3.1、受け口は別の小さなコンテナで開発の一式の内側だけに公開し送り手の住所を許可の一覧で絞る、漢字は MSH-18 の UTF-8、HL7 経由の更新では UID を保つ。
- 送り手の形は ris-emulator の `docs/spec/06_hl7_pir.md`（3 つのメッセージの例、エスケープ、MLLP と ACK）。原典は IHE RAD TF-2 Rev. 23.0 の 2.4・4.4・4.12。

## Goals / Non-Goals

**Goals:**

- ris-emulator の `pir send` が送る ADT^A40・ADT^A08・ORM^O01（NW）を受け、Orthanc の検査の患者と受付番号を、UID を保ったまま揃える。
- 認証の無い TCP の待ち受けを、BFF の公開の面に足さない。待ち受けは開発の一式の内側だけにし、送り手の住所で絞る。
- 監査の記録を 1 本のつなぎのまま保つ（受け口の側に別の記録を作らない）。

**Non-Goals:**

- IHE への適合の主張。tsunagi-dicom は Image Manager のほかの必須のトランザクションを実装していない。
- RAD-13（ORM の CA・DC・XO）、A02・A03・A06・A07、HL7 v2.5.1 の OMI、Report Manager の役。
- 配る compose に受け口を入れること。施設のネットワークで使う形は、この change では作らない。
- 画面に HL7 の受け取りの一覧を出すこと（監査の記録には残す）。

## Decisions

### 1. 置き場：受け口は MLLP の中継だけ、解析と反映は BFF

```text
ris-emulator ──MLLP（dicom のネットワーク）──> hl7-receiver ──HTTP＋token（backend のネットワーク）──> tsunagi-dicom（BFF）──REST──> Orthanc
                                   許可の一覧・大きさ・時間                      解析・ACK・監査の記録・書き換え
```

- 受け口（`hl7-receiver`）は、TCP の待ち受け・送り手の住所の確かめ・MLLP の枠・大きさと時間の上限・BFF への受け渡しだけを持つ。
  HL7 の中身は読まない。BFF が答えなければ、ACK を返さずに接続を閉じる（送り手は「失敗」として扱い、送り直せる。ris-emulator の 06 の 4 章）。
- BFF は、受け口から受けたメッセージを解析し、Orthanc を書き換え、ACK を作って返す。役割の確かめと監査の記録は、いまの書き込みの操作と同じ BFF の中に置く。
- 別の案は、受け口のコンテナが解析・監査・Orthanc の呼び出しまで持つ形。BFF に道を足さずに済むが、監査のつなぎの鍵（`SESSION_SECRET`）と Orthanc の書く資格情報を、もう 1 つのコンテナに渡すことになる。
  データベースのファイルを 2 つのプロセスで書き合うことにもなるので採らない。
- もう 1 つの案は、BFF に TCP の待ち受けを足す形。BFF の公開の面に認証の無い待ち受けが増えるので採らない（承認者の決定）。

### 2. BFF の内部の API：`POST /api/hl7/messages`

- 設定 `HL7_RECEIVER_TOKEN_FILE`（token のファイル。32 文字以上）があるときだけ道を開く。無ければ 404 を返す。
- 要求は `Authorization: Bearer <token>`。token は SHA-256 にしてから定数時間で比べる。違えば 401 を返し、ログに残す（token は出さない）。監査の記録には残さない（受け口を名乗る者の誤りで、つなぎを埋めないため）。
- 本文は JSON：`{ "peer": "<送り手の住所>", "message": "<HL7 の本文の base64>" }` か、`{ "peer": "<住所>", "event": "refused" | "oversize" | "timeout" | "framing" }`。
  本文は 2 MiB まで（base64 にした 1 MiB のメッセージが入る大きさ）。形が違えば 400。
- 答えは `{ "ack": "<ACK の本文の base64>" }`。`event` の知らせには `{ "ok": true }`。
- 画面の利用者のセッション・CSRF は使わない（ブラウザから呼ぶ道ではない）。役割の表（`src/lib/auth/roles.ts`）にも足さない。どの役割のセッションで呼んでも、token が無ければ 401 にする。
- メッセージは BFF の中で 1 通ずつ順に処理する（A40 の後に ORM が続けて来ても、書き換えが重ならない）。

### 3. Orthanc の呼び方：UID を保つ書き換え

2026-10-24 に開発の一式の Orthanc（orthancteam/orthanc:26.9.1、Orthanc 1.13.0）で実測した結果に従う。

```text
POST /studies/{Orthanc の検査の ID}/modify
{ "Replace": { PatientID, PatientName, PatientBirthDate, PatientSex[, AccessionNumber] },
  "Keep": ["StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID"],
  "Force": true, "KeepSource": false }
```

- `KeepSource: false` を必ず付ける。省くと同じ StudyInstanceUID の検査が 2 件並び、tsunagi-dicom の引き当てが 409 になる。
- 替え先の患者 ID がすでに Orthanc にあると、患者のタグを全部 `Replace` に入れないと 400 になる。そのため、患者の 4 つのタグ（PatientID・PatientName・PatientBirthDate・PatientSex）をいつも入れる。
  HL7 の欄が空のタグは、その検査のいまの値を入れる（HL7 の空の欄は「変えない」。`""` の明示の削除は扱わず、いまの値を保つ）。
- 書き換えると Orthanc の中の検査の ID が変わる（患者 ID が ID の元に入るため）。答えの `ID` を新しい ID として監査の記録に残す。
- 元の検査は Orthanc から消え、戻せない。監査の記録の前の値から、人が書き戻すことはできる。
- 患者を探すのは `POST /tools/find`（`Level: Study`、`Query: { PatientID }`、`Expand: false`）。患者 ID に `*`・`?`・`\`・制御文字があれば、探さずに AE にする（Orthanc の検索で字の当てはめになるため）。
- 受付番号を探すのは、いまの `lookupStudyIds`（`/tools/lookup`）。答えが 2 件以上なら選ばずに AE にする。

### 4. `OverwriteInstances` が要る場面

患者 ID を変えない書き換え（A08 と ORM）では、書き換えた画像の Orthanc の中の ID が元と同じになる。Orthanc は、設定 `OverwriteInstances: true` が無いとこれを 400 で断る（実測の #7）。

- 開発の一式の Orthanc（`docker/dev/orthanc/site.json`）を `OverwriteInstances: true` にする。同じ SOP Instance UID の画像を送り直したときも、無視ではなく上書きになる。開発の一式では、DTG の送り直しで新しい版に替わるだけで、困る使い方は無い。
- 配る compose（`deploy/orthanc/orthanc.json`）と結合の試験の Orthanc は変えない。受け口の無い一式で既定を変える理由が無い。
- `OverwriteInstances` の無い Orthanc で A08・ORM を受けたときは、Orthanc の 400 をそのまま失敗として AE を返し、理由に「Orthanc の OverwriteInstances が要る」と書く。

### 5. メッセージの解析と、扱う欄

区切りは `|`、`^~\&` だけを受ける（MSH-1・MSH-2 がこれと違えば AR）。セグメントの区切りは CR（CR の直後の LF は読み飛ばす）。

- エスケープは `\F\`・`\S\`・`\T\`・`\R\`・`\E\` を戻す。ほかのエスケープ（`\X..\`・`\H\` など）は AR にする。戻した後の値に制御文字（C0・DEL・C1）があれば AR にする。
- 文字コード：本文は UTF-8 として読む。UTF-8 として正しくなければ AR。MSH-18 は空か `UNICODE UTF-8` だけを受ける。それ以外は AR。
- MSH-12 は `2.3.1` だけを受ける。MSH-9 は 1 つめと 2 つめで種類を決める（3 つめの構造の名前は見ない。IHE は A08 に `ADT_A01`、ris-emulator は `ADT_A08` を使う）。
- 患者 ID：PID-3 の繰り返しのうち、種類（CX の 5 つめ）が `PI` のもの、無ければ最初のものの 1 つめ。旧い患者 ID は MRG-1 で同じ。64 文字まで、空・前後の空白・`\`・`*`・`?` は AE。
- 氏名：PID-5 の繰り返しを、表記の種類（XPN の 8 つめ）の `A`・`I`・`P` で、DICOM の PN の英字・漢字・かなのグループにする。表記の種類が無ければ、繰り返しの順（英字・漢字・かな）で読む。
  XPN の `姓^名^ミドル^接尾辞^接頭辞` を、PN の `姓^名^ミドル^接頭辞^接尾辞` に並べ替える。氏名が空なら、その検査のいまの氏名を保つ。
- 生年月日：PID-7 の先頭の 8 桁（`YYYYMMDD`。実在する日付）。ほかの形は AE。性別：PID-8 の `M`・`F`・`O` だけ。ほかは AE（`U` と空は変えない）。
- ORM：ORC-1 が `NW` だけを扱う（ほかは AR）。受付番号は OBR-18、Study Instance UID は ZDS-1 の 1 つめ。UID の形（数字と点、64 文字まで）でなければ AE。

### 6. 3 つのメッセージの反映

| メッセージ | 探す | 書き換える | 見つからないとき |
|---|---|---|---|
| A40 | MRG-1 の旧い患者 ID の検査（全部） | 患者の 4 つのタグを PID の値に | 何もせず AA（理由に「旧い患者の検査が無い」）。IHE は患者を作るとするが、画像の無い患者は Orthanc に作れない |
| A08 | PID-3 の患者 ID の検査（全部） | 氏名・生年月日・性別（PID の空の欄は変えない） | 何もせず AA |
| ORM の NW | ZDS-1 の Study Instance UID の検査（1 件） | 受付番号（OBR-18） | 何もせず AA（画像がまだ届いていない） |

- ORM：検査の患者 ID が ORM の PID-3 と違えば、書き換えずに AE（「患者 ID が一致しない。先に A40 を送る」）。RAD-13 は ORM の PID で患者を更新しないとしている。
- ORM：検査の受付番号が空なら入れる。同じなら何もせず AA。別の値が入っていれば、書き換えずに AE（取り違えの恐れがあるので、人が確かめる）。
- A40・A08 で検査が複数あるときは、1 件ずつ順に書き換える。途中で失敗したら、そこで止めて AE を返す（書き換えた検査は監査の記録に残る）。
- 送り直された同じメッセージ（同じ MSH-10）は、もう一度流す。A40 は旧い患者が無くなっているので何もせず、A08・ORM は同じ値になるので、結果は変わらない。

### 7. ACK

- `MSH|^~\&|<受けた MSH-5>|<受けた MSH-6>|<受けた MSH-3>|<受けた MSH-4>|<時刻>||ACK^<受けた MSH-9 の 2 つめ>|<新しい ID>|P|2.3.1`、続けて `MSA|<AA・AE・AR>|<受けた MSH-10>|<文>`。AE・AR のときは `ERR` も足す。
- 文に日本語を入れるときは MSH-18 を `UNICODE UTF-8` にする。受けた MSH-3〜6 と MSH-10 は、区切りの字と制御文字を除いてから入れる。
- MSH が読めず MSH-10 も分からないときは、MSA-2 を空にした AR を返す。

### 8. 受け口の上限と許可の一覧

- 許可の一覧 `HL7_ALLOWED_SOURCES`：空白かカンマで区切った IP アドレス・CIDR・ホストの名前。名前は接続のたびに引き直す（コンテナの住所は起き直すと変わる）。空なら起動しない。
  一覧に無い住所からの接続は、何も読まずに閉じ、BFF に `refused` を知らせる（同じ住所は 1 分に 1 回まで。監査の記録を埋めないため）。
- 1 通の大きさは 1 MiB まで（`HL7_MAX_MESSAGE_BYTES`）。超えたら閉じる。枠の外のバイトが来たら閉じる。
- 時間：接続から 1 通を読み終えるまで 30 秒（`HL7_READ_TIMEOUT_SECONDS`）。読み終えた後は、BFF の答えを 60 秒まで待つ。
- 同時の接続は 8 まで。超えた接続はすぐ閉じる。1 つの接続で複数のメッセージを順に受けてよい（受けた順に 1 通ずつ答える）。
- 受け口のログに出す外の値（住所・理由）は、制御文字を見える形にしてから出す。HL7 の本文はログに出さない。

### 9. 監査の記録

操作 `hl7` を足す。行の `actorId` は `hl7-receiver`、`actorRole` は `system`、`authMode` は `hl7`、`sourceAddress` は受け口が確かめた送り手の住所。

| `detail.event` | いつ | outcome |
|---|---|---|
| `refused`・`oversize`・`timeout`・`framing` | 受け口の知らせ | denied |
| `rejected` | AR を返す | denied |
| `request` | Orthanc の書き換えを呼ぶ前（記録できなければ呼ばずに AE） | success |
| `result` | 呼んだ後。前と後の値、元と新しい Orthanc の ID、StudyInstanceUID | success・failed・unknown |
| `ack` | ACK を返す前。種類・MSH-10・送り手の MSH-3/4・ACK のコード・件数 | success（AA）・failed（AE） |

- `request` と `result` には、メッセージごとの要求の ID（乱数の UUID）と MSH-10 を入れて結ぶ。
- 理由の文と、送り手が書いた値（MSH-3/4・MSH-10）は、制御文字を見える形にしてから入れる。患者 ID と氏名は、5 で制御文字を断った後の値なので、そのまま入れる。
- Orthanc の答えが来ない（時間切れ・通信の切れ）ときは、`result` を `unknown` にして AE を返す。照らし合わせは、送り手の送り直し（同じ結果になる。6）と、人が記録を読むことで行う。

### 10. 制御文字を見える形にする

外から来た値をログ・監査の記録の理由・ACK の文・端末に出す前に、次の字を `\uXXXX` にする：C0（U+0000〜U+001F）、DEL（U+007F）、C1（U+0080〜U+009F）、
双方向の書式の字（U+061C・U+200E・U+200F・U+202A〜U+202E・U+2066〜U+2069）、行と段落の区切り（U+2028・U+2029）。
ris-emulator の #21 で指摘された「端末の制御文字の注入」と同じ類を作らないため。受け口と BFF で同じ規則にする。

## Risks / Trade-offs

- **同じ UID で中身の違う画像ができる。** Orthanc の資料は勧めていない。元の版を受け取った機器があれば、その機器では古い患者 ID のまま残る。PIR の流れでは UID が照合の鍵なので、HL7 の道だけで受け入れる（承認者の決定 2）。
- **元の検査は戻せない**（`KeepSource: false`）。前の値は監査の記録に残るが、画素以外を元に戻すのは人の作業になる。
- **MLLP に認証は無い。** 許可の一覧は住所で絞るだけで、同じネットワークの中で住所を偽る相手は防げない。開発の一式の内側だけに置く理由はこれ。
- **受け口と BFF の間の token** が漏れると、許可の一覧を通らずに BFF の道を呼べる。token は Docker の secret にし、BFF の公開のポートからも呼べることを文書に書く。
- **A40 の途中の失敗**で、患者の検査の一部だけが書き換わることがある。送り直せば残りが書き換わる（6）。

## Migration Plan

- 配る compose は変えないので、いまの利用者への影響は無い。
- 開発の一式は、`docker/dev/up.sh` が token の secret を作り、受け口を立てる。ris-emulator の版を `pir send` のある版（main の 3573572）に上げる。
  ris-emulator の `hl7.host` は環境変数で替えられないので、送るときに `pir send --host hl7-receiver` で受け口を名指しする。
- 戻すときは、開発の一式から受け口を外し、`HL7_RECEIVER_TOKEN_FILE` を消す（BFF の道は 404 に戻る）。
