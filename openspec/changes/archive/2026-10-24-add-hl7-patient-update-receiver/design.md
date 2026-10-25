# Design

## Context

動機は proposal.md の Why。この設計に効くいまの形と、決まっていることは次のとおり。

- 書き込みは、決めた操作ごとの Orthanc の REST だけを BFF から呼ぶ。Orthanc を呼ぶ前に「求めた」ことを監査の記録に残し、記録できなければ呼ばない（`docs/spec.md` の 3.5）。
- 監査の記録は BFF のデータベース（SQLite）の 1 本のつなぎで、行は鍵つきの HMAC でつなぐ。鍵は `SESSION_SECRET` から導く（`docs/adr/0001-audit-chain-mac.md`）。
- 配る compose では、tsunagi-dicom は `backend`（内部）と `web` のネットワーク、Orthanc は `backend` と `dicom` のネットワークに入る。開発の一式では ris-emulator・DTG が `dicom` に入る。
- 決定（2026-10-24 19:33、PIR の提案の 5.2）：受け方は HL7 v2 の受け口（A）、Orthanc を書き換える（A1）、HL7 v2.3.1、受け口は別の小さなコンテナで開発の一式の内側だけに公開し送り手の住所を許可の一覧で絞る、漢字は MSH-18 の UTF-8、HL7 経由の更新では UID を保つ。
- 送り手の形は ris-emulator の `docs/spec/06_hl7_pir.md`（3 つのメッセージの例、エスケープ、MLLP と ACK）。原典は IHE RAD TF-2 Rev. 23.0 の 2.4・4.4・4.12。

## Goals / Non-Goals

**Goals:**

- ris-emulator の `pir send` が送る ADT^A40・ADT^A08・ORM^O01（NW）を受け、Orthanc の検査の患者と受付番号を、UID を保ったまま揃える。
- 認証の無い TCP の待ち受けを、BFF の公開の面に足さない。待ち受けは開発の一式の内側だけにし、送り手の住所で絞る。
- 監査の記録を 1 本のつなぎのまま保つ（受け口の側に別の記録を作らない）。
- 結果の分からない書き換えを、送り直しで重ねない。

**Non-Goals:**

- IHE への適合の主張。tsunagi-dicom は Image Manager のほかの必須のトランザクションを実装していない。
- RAD-13（ORM の CA・DC・XO）、A02・A03・A06・A07、HL7 v2.5.1 の OMI、Report Manager の役。
- 配る compose に受け口を入れること。施設のネットワークで使う形は、この change では作らない。
- 画面に HL7 の受け取りの一覧を出すこと、結果不明の HL7 の書き換えを画面で解くこと（監査の記録には残す）。
- 複数の発番元の患者 ID を 1 つの Orthanc で扱うこと。

## Decisions

### 1. 置き場：受け口は MLLP の中継だけ、解析と反映は BFF

```text
ris-emulator ──MLLP（hl7 のネットワーク）──> hl7-receiver ──HTTP＋token（backend のネットワーク）──> tsunagi-dicom（BFF）──REST──> Orthanc
                                 許可の一覧・大きさ・時間                       解析・ACK・監査の記録・書き換え
```

- 受け口（`hl7-receiver`）は、TCP の待ち受け・送り手の住所の確かめ・MLLP の枠・大きさと時間の上限・BFF への受け渡しだけを持つ。
  HL7 の中身は読まない。BFF が答えなければ、ACK を返さずに接続を閉じる（送り手は「失敗」として扱い、送り直せる。ris-emulator の 06 の 4 章）。
- BFF は、受け口から受けたメッセージを解析し、Orthanc を書き換え、ACK を作って返す。監査の記録は、いまの書き込みの操作と同じ BFF の中に置く。
- 別の案は、受け口のコンテナが解析・監査・Orthanc の呼び出しまで持つ形。BFF に道を足さずに済むが、監査のつなぎの鍵（`SESSION_SECRET`）と Orthanc の書く資格情報を、もう 1 つのコンテナに渡すことになる。
  データベースのファイルを 2 つのプロセスで書き合うことにもなるので採らない。
- もう 1 つの案は、BFF に TCP の待ち受けを足す形。BFF の公開の面に認証の無い待ち受けが増えるので採らない（決定）。

### 2. 届く範囲

開発の一式では、受け口のために `hl7` のネットワークを作り、受け口と ris-emulator だけを入れる。受け口は BFF へ渡すために `backend` にも入る。ホストにポートを出さない。

| 経路 | 届くか | 受け口の扱い |
|---|---|---|
| ris-emulator（`hl7`） | 届く | 許可の一覧に名前 `ris` を書き、通す |
| tsunagi-dicom・Orthanc（`backend`） | TCP は届く | 許可の一覧に無いので、読まずに閉じる |
| DTG・storescp（`dicom`） | 届かない | 受け口は `dicom` に入らない |
| ホスト（Docker のブリッジの住所） | Linux では届きうる | 許可の一覧に無いので、読まずに閉じる |

- 許可の一覧は住所で絞るだけで、同じネットワークの中で住所を偽る相手は防げない。信じる範囲は「`hl7` のネットワークに入れたコンテナ」とする。

### 3. BFF の内部の API：`POST /api/hl7/messages`

- 設定 `HL7_RECEIVER_TOKEN_FILE` と `HL7_PATIENT_ID_ISSUER`（6）の両方があるときだけ道を開く。どちらも無ければ 404。片方だけ・token が 32 文字未満・ファイルが読めないときは、設定の誤りとして起動しない。
  開発の一式の token は、`up.sh` が乱数 32 バイトから作る。
- 要求は `Authorization: Bearer <token>`。token は SHA-256 にしてから定数時間で比べる。違えば 401 を返し、ログに 1 行残す（token は出さない）。監査の記録には残さない（受け口を名乗る者の誤りで、つなぎを埋めないため）。
  画面の利用者のセッションの cookie があっても、token が無ければ 401。
- 本文は JSON：`{ "peer": "<住所>", "message": "<HL7 の本文の base64>" }` か、`{ "peer": "<住所>", "event": "refused" | "oversize" | "timeout" | "framing" | "busy" | "dropped", "count"?: 1〜1000000 の整数, "since"?: ISO 8601, "until"?: ISO 8601 }`。
  `count`・`since`・`until` は `busy`（まとめた数と期間）と `dropped`（落とした知らせの数と期間）で必須、ほかでは付けない。`dropped` の `peer` は受け口自身の名前（`hl7-receiver`）。受け口は `dropped` を、届いた次の知らせの直後に別の要求で送る。
  本文は読みながら 2 MiB で打ち切る（`content-length` を信じない）。base64 は字と長さを確かめ、戻した後が 1 MiB を超えれば 400。形が違えば 400。
- 答えは `{ "ack": "<ACK の本文の base64>" }`。`event` の知らせには `{ "ok": true }`。
- **人のセッションと別の、機械の主体として扱う。** 役割の表（`src/lib/auth/roles.ts`）には足さない（役割は画面の利用者のもの）。CSRF の対策は cookie で動く要求のためのもので、この道は cookie を使わず token だけで通すので当てない。代わりに、token の誤り・設定の無いとき・セッションだけの要求を断る試験を付ける。`AGENTS.md` の設計の決まりに、この例外を 1 行足す。
- `AUTH_MODE=dev` のときは、`DEV_ALLOW_WRITE=true` でなければ書き換えを呼ばずに AE を返す（ほかの書き込みの操作と同じ）。
- メッセージは BFF の中で 1 通ずつ順に処理する。待ちは 16 通まで。超えたら 503 を返し、受け口は ACK を返さずに閉じる。
- `peer` は受け口が申告した住所なので、監査の記録の「確かめていない接続元」（`sourceAddressUnverified`）に入れる。

### 4. Orthanc の呼び方：UID を保つ書き換え

2026-10-24 に開発の一式の Orthanc（orthancteam/orthanc:26.9.1、Orthanc 1.13.0）で実測した結果に従う。

```text
POST /studies/{Orthanc の検査の ID}/modify
{ "Replace": { PatientID, PatientName, PatientBirthDate, PatientSex[, AccessionNumber] },
  "Keep": ["StudyInstanceUID", "SeriesInstanceUID", "SOPInstanceUID"],
  "Force": true, "Asynchronous": true[, "KeepSource": false（A40 だけ）] }
```

- **Orthanc の仕事（job）として流す**（`Asynchronous: true`）。答えの仕事の ID を `dispatch` の行に残し、`/jobs/{id}` を読んで `Success`・`Failure` になるまで待つ（120 秒まで）。
  時間切れの後も Orthanc の中で処理が続きうるので、仕事が終わったと読めるまでは結果を決めない（10）。
- **終わった後に、画像ごとに確かめる。** 書き換えの前に、検査の画像ごとの UID の組（StudyInstanceUID・SeriesInstanceUID・SOPInstanceUID）の一覧を `request` に残す。仕事が `Success` になったら、StudyInstanceUID で検査を引き当て（ちょうど 1 件）、`/studies/{id}/instances-tags` で全部の画像の UID の組と PatientID・PatientName・PatientBirthDate・PatientSex・AccessionNumber を読み、
  UID の組の一覧と件数が前と同じで、全部の画像が予定の値になっていれば成功とする。1 枚でも違えば `partial` として AE を返し、後のメッセージを止める（10）。
- 仕事が `Failure` になったとき・Orthanc が書き換えを断った（400 など）ときも、同じ読み方で全部の画像を確かめる。全部が前の値のままなら失敗（`failed`）として決め、AE を返す。そうでなければ `partial` にして後のメッセージを止める。
- **`KeepSource: false` は、患者 ID が変わる書き換え（A40）にだけ付ける。** 省くと同じ StudyInstanceUID の検査が 2 件並び、tsunagi-dicom の引き当てが 409 になる。
  患者 ID が変わらない書き換え（A08・ORM）には付けない（既定の残す）。書き換えた画像の Orthanc の中の ID が元と同じなので、`OverwriteInstances` で元の画像が置き換わり、2 件は並ばない。
  ここで `KeepSource: false` を付けると、Orthanc は置き換えた後に元の ID の画像を消すので、書き換えた画像ごと検査が消える（2026-10-24 21:05 に開発の一式の A08 で起きた。架空の患者の検査）。
- A40 で MRG-1 と PID-3 の患者 ID が同じなら、書き換えずに AE（患者 ID が変わらないのに `KeepSource: false` を付けることになるため）。
- 替え先の患者 ID がすでに Orthanc にあると、患者のタグを全部 `Replace` に入れないと 400 になる。そのため、患者の 4 つのタグ（PatientID・PatientName・PatientBirthDate・PatientSex）をいつも入れる。
- 書き換えると Orthanc の中の検査の ID が変わる（患者 ID が ID の元に入るため）。引き当て直した ID を新しい ID として監査の記録に残す。
- 元の検査は Orthanc から消え、戻せない。監査の記録の前の値から、人が書き戻すことはできる。
- 患者を探すのは `POST /tools/find`（`Level: Study`、`Query: { PatientID }`、`Expand: false`。読む資格情報）。患者 ID に `*`・`?`・`\`・制御文字があれば、探さずに AE にする（Orthanc の検索で字の当てはめになるため）。
- 受付番号の書き換えで探すのは、いまの `lookupStudyIds`（`/tools/lookup`）。答えが 2 件以上なら選ばずに AE にする。
- 日本語の値を書くときは、検査の SpecificCharacterSet が `ISO_IR 192` であることを確かめる。ほかの文字の集合の検査には日本語を書かずに AE にする（Orthanc の変換に任せた結果を確かめていないため）。英字だけの値は、どの文字の集合の検査にも書く。

### 5. `OverwriteInstances` が要る場面

患者 ID を変えない書き換え（A08 と ORM）では、書き換えた画像の Orthanc の中の ID が元と同じになる。Orthanc は、設定 `OverwriteInstances: true` が無いとこれを 400 で断る（実測の #7）。

- 開発の一式の Orthanc（`docker/dev/orthanc/site.json`）と、結合の試験の Orthanc（`docker/test/orthanc/orthanc.json`）を `OverwriteInstances: true` にする。同じ SOP Instance UID の画像を送り直したときも、無視ではなく上書きになる。
  開発の一式では、DTG の送り直しで新しい版に替わるだけで、困る使い方は無い。結合の試験は、いまの場面のどれも送り直しの無視に頼っていないことを確かめてから変える。
- 配る compose（`deploy/orthanc/orthanc.json`）は変えない。受け口の無い一式で既定を変える理由が無い。
- `OverwriteInstances` の無い Orthanc で A08・ORM を受けたときは、Orthanc の 400 を失敗として AE を返し、理由に「Orthanc の OverwriteInstances が要る」と書く。

### 6. 患者 ID の発番元

- 設定 `HL7_PATIENT_ID_ISSUER` に、受ける患者 ID の発番元（CX の 4 つめの 1 つめの下位成分。namespace ID。ris-emulator は `RIS_EMU`）を 1 つだけ書く。発番元は namespace ID だけで見分ける。CX の 4 つめの 2 つめ・3 つめ（universal ID とその種類）に値があれば AE。Orthanc の患者 ID は、すべてこの発番元のものとみなす（1 つの施設の一式だけで使う前提。Non-Goals）。
- PID-3 と MRG-1 は、繰り返しのうち発番元がこれと同じで、種類（CX の 5 つめ）が `PI` か空のものを選ぶ。ちょうど 1 つでなければ AE（0 件は「発番元の違う患者 ID」、2 件以上は「どれか決められない」）。

### 7. メッセージの解析

1. 本文を UTF-8 として読む。正しくなければ AR。MSH-18 が空なら、本文は ASCII だけでなければ AR。MSH-18 が `UNICODE UTF-8` なら UTF-8 を受ける。ほかの値は AR。
2. セグメントを CR で分ける（CR の直後の LF は読み飛ばす）。最初のセグメントは MSH。MSH-1 は `|`、MSH-2 は `^~\&` だけを受ける。
3. **生の区切りで木を作ってから、末端の値を 1 度だけ戻す。** 欄（`|`）・繰り返し（`~`）・成分（`^`）・下位成分（`&`）に分けた後で、エスケープ `\F\`・`\S\`・`\T\`・`\R\`・`\E\` を戻す。戻した字を区切りとして読み直さない。ほかのエスケープ（`\X..\`・`\H\` など）は AR。
4. 戻した後の値に、14 の字（C0・DEL・C1・双方向の書式の字・行と段落の区切り）があれば AR。
5. MSH-12 は `2.3.1` だけを受ける。MSH-9 の繰り返しは AR。種類と構造の名前は次の組だけを受け、ほかは AR。

   | MSH-9 | 構造の名前（3 つめ） | 根拠 |
   |---|---|---|
   | `ADT^A40` | 空・`ADT_A39` | IHE RAD TF-2 4.12.4.4.2.1.1 |
   | `ADT^A08` | 空・`ADT_A01`・`ADT_A08` | `ADT_A01` は IHE RAD TF-2 4.12.4.3.2.1.1。`ADT_A08` は ris-emulator の 06 の 2.1 |
   | `ORM^O01` | 空・`ORM_O01` | IHE RAD TF-2 4.4.4.1.2.1.1 |

6. セグメントの数：MSH・PID はちょうど 1 つ。A40 は MRG がちょうど 1 つ。ORM は ORC・OBR・ZDS がちょうど 1 つずつ。ほかのセグメント（EVN・PV1 など）は読まずに受ける。数が合わなければ AR（変更の前に断る）。
7. ORM の ORC-1 は `NW` だけ。ほかは AR。
8. 使う欄の形：下の表より多い繰り返し・成分があれば AR。下位成分（`&`）は CX の 4 つめ（3 つまで）のほかは 1 つだけで、2 つ以上なら AR（`M&F` は AR、エスケープした `M\T\F` は 1 つの値 `M&F` として 8 の値の確かめへ進む）。表に無い欄は読まない。

   | 欄 | 繰り返し | 成分 |
   |---|---|---|
   | MSH-3〜6・MSH-11・MSH-12・MSH-18 | 1 | 1（MSH-3〜6 は HD の 3 つまで） |
   | MSH-9 | 1 | 3 |
   | MSH-10 | 1 | 1。必須（1〜20 字、空白・区切りの字なし）。空なら AR |
   | PID-3・MRG-1 | 4 まで | CX の 5 つまで（4 つめは下位成分 3 つまで） |
   | PID-5 | 3 まで | XPN の 8 つまで |
   | PID-7 | 1 | 1 |
   | PID-8 | 1 | 1 |
   | ORC-1 | 1 | 1 |
   | OBR-18 | 1 | 1 |
   | ZDS-1 | 1 | 4 |

9. メッセージ全体を確かめ終えるまで、Orthanc は呼ばない。

### 8. 値の取り出しと DICOM の値の確かめ

| 値 | 欄 | 確かめ（合わなければ AE） |
|---|---|---|
| 患者 ID・旧い患者 ID | PID-3・MRG-1（6 で選んだ繰り返しの 1 つめ） | 1〜64 文字（LO）、前後の空白なし、`\`・`*`・`?` なし |
| 氏名 | PID-5 | 下の規則。成分に `\`・`=`・`^` を含まない。並べ替えた後のグループ（英字・漢字・かなのそれぞれ。区切りの `^` を含む）は 64 文字まで（DICOM PS3.5 の 6.2 の PN） |
| 生年月日 | PID-7 の先頭 8 字 | `YYYYMMDD` の実在する日付 |
| 性別 | PID-8 | `M`・`F`・`O`。`U` と空は「変えない」 |
| 受付番号 | OBR-18 | 1〜16 文字（SH）、`\` なし |
| Study Instance UID | ZDS-1 の 1 つめ | 64 文字まで、`.` で区切った数字の並び、各要素は `0` か 0 で始まらない数字 |

- 氏名：PID-5 の繰り返しを、表記の種類（XPN の 8 つめ）の `A`・`I`・`P` で、DICOM の PN の英字・漢字・かなのグループにする。同じ種類が 2 つあれば AR。どの繰り返しにも種類が無ければ、繰り返しの順（英字・漢字・かな）で読む。種類のあるものと無いものが混ざれば AR。
  XPN の `姓^名^ミドル^接尾辞^接頭辞` を、PN の `姓^名^ミドル^接頭辞^接尾辞` に並べ替える。
- HL7 の空の欄は「変えない」とする。`""`（HL7 の明示の削除）は扱わず、AE にする。

### 9. 3 つのメッセージの反映

| メッセージ | 探す | 書き換える | 見つからないとき |
|---|---|---|---|
| A40 | MRG-1 の旧い患者 ID の検査（全部） | 患者の 4 つのタグを、下の規則で決めた値に | 何もせず AA（理由に「旧い患者の検査が無い」）。IHE は患者を作るとするが、画像の無い患者は Orthanc に作れない |
| A08 | PID-3 の患者 ID の検査（全部） | 氏名・生年月日・性別（空の欄は変えない） | 何もせず AA |
| ORM の NW | ZDS-1 の Study Instance UID の検査（1 件） | 受付番号（OBR-18） | 何もせず AA（画像がまだ届いていない） |

- **A40 の替え先の患者がすでにあるとき**：PID-3 の患者 ID の検査を Orthanc で探し、その患者のいまの値（氏名・生年月日・性別）を読む。PID の空でない値が、そのいまの値と違えば、何も書き換えずに AE（「替え先の患者の属性が違う。先に A08 で揃える」）。空の欄は、替え先のいまの値で埋める。
  替え先の検査どうしで値が揃っていなければ AE。
- **A40 の替え先の患者がまだ無いとき**：PID の空の欄は、旧い患者の検査のいまの値で埋める。旧い患者の検査どうしで値が揃っていなければ AE。
- ORM：検査の患者 ID が ORM の PID-3 と違えば、書き換えずに AE（「患者 ID が一致しない。先に A40 を送る」）。RAD-13 は ORM の PID で患者を更新しないとしている。
- ORM：検査の受付番号が空なら入れる。同じなら何もせず AA。別の値が入っていれば、書き換えずに AE（取り違えの恐れがあるので、人が確かめる）。
- A40・A08 で検査が複数あるときは、1 件ずつ順に書き換える。途中で失敗したら、そこで止めて AE を返す（書き換えた検査は監査の記録に残る）。

### 10. 同じメッセージと、結果の分からない書き換え

- **受けたことを先に残す**：解析を通ったメッセージは、Orthanc を読む前に `received` の行（送り手の MSH-3・MSH-4、MSH-10、本文の SHA-256、メッセージの ID）を残す。残せなければ AE。
- **同じメッセージ**：送り手と MSH-10 の組で、前の `received` の行を探す（直近 7 日）。
  - 前の行があり、本文の SHA-256 が違えば AR（同じ MSH-10 の別の中身）。
  - 本文が同じで、そのメッセージの `ack` の行があれば、Orthanc を呼ばずに前と同じ ACK のコードを返す。古い A08 の送り直しで、新しい A08 の値が巻き戻らないようにするため。
  - 本文が同じで `ack` の行が無い（処理の途中で BFF が止まった）ときは、下の「途中で止まったメッセージ」として扱う。
- **解いていない書き換え**：`request` の行があり、`result` の結果が決まっていない（`result` が無い・`unknown`・`partial`）書き換え。`failed` は、4 のとおり全部の画像が前の値のままと確かめたときだけ付けるので、解いたものとして扱う。新しいメッセージを処理する前に、全部を照らす。
  - 仕事の ID がある（`dispatch` の行がある）：`/jobs/{id}` を読む。`Success` なら 4 の画像ごとの確かめをして、`reconcile` の行で成功か `partial` を足す。`Failure` なら、4 と同じ確かめで前の値のままなら「書き換わらなかった」として解く。まだ動いている・読めないときは解かない。
  - 仕事の ID が無い（Orthanc に送ったが答えが来なかった）：仕事が作られたかが分からないので、自動では解かない。
  - `partial` は自動では解かない（画像の一部だけが書き換わっている）。
  - 解けないものが 1 つでもあれば、新しいメッセージに AE（「結果の分からない書き換えがある」）を返し、Orthanc を変えない。
- **人が解く道**：`POST /api/hl7/resolve`（管理者だけ。`pacs.reconcile`。画面の書き込みの決まり（CSRF・ロック）を通す）。本文は書き換えごとの ID と、Orthanc の側で処理が終わったことをどこでどう確かめたかの文（必須）。
  BFF は Orthanc をもう一度読み（4 の画像ごとの確かめ）、見た結果を `reconcile`（`manual: true`）の行に足して解く。Orthanc には書かない。書き戻しが要るなら、人が Orthanc の側で行う。画面は作らない（削除の照らし合わせと同じく、API だけ）。
- **途中で止まったメッセージ**：`received` の行があって `ack` の行が無いメッセージ。そのメッセージの書き換えが全部解けていれば、`ack` の行を AE（`interrupted`）で足して閉じる。同じ MSH-10 の送り直しには、この AE を返す（送り手は新しい MSH-10 で送り直す）。
- **記録の失敗**：`request` を書けなければ Orthanc を呼ばずに AE。Orthanc を呼んだ後に `dispatch`・`result` を書けなければ、その書き換えは解いていないまま残り、ACK は AE にする。`ack` の行を書けなければ AE を返す（そのメッセージは途中で止まったメッセージになる）。
- **受け口の知らせ**：BFF に届けられなければ、受け口は 3 回まで（1 秒・5 秒・30 秒の後）送り直す。それでも届かなければ数を数えておき、次に知らせが届いたときに `dropped`（落とした数と期間）として一緒に送る。受け口が起き直すと、この数は失われる（ログには残る）。

### 11. ACK

- `MSH|^~\&|<受けた MSH-5>|<受けた MSH-6>|<受けた MSH-3>|<受けた MSH-4>|<時刻>||ACK^<受けた MSH-9 の 2 つめ>|<新しい ID>|P|2.3.1`、続けて `MSA|<AA・AE・AR>|<受けた MSH-10>|<文>`。AE・AR のときは `ERR` も足す。
- 文に日本語を入れるときは MSH-18 を `UNICODE UTF-8` にする。受けた MSH-3〜6 と MSH-10 は、区切りの字（`|^~\&`）と 14 の字を除いてから入れる。文は区切りの字をエスケープする。
- MSH が読めず MSH-10 も分からないときは、MSA-2 を空にした AR を返す。

### 12. 受け口の上限と許可の一覧

- 許可の一覧 `HL7_ALLOWED_SOURCES`：空白かカンマで区切った IP アドレス・CIDR・ホストの名前。空、または読めない項目があれば起動しない。比べるのは socket の相手の住所だけ。IPv4 を写した IPv6（`::ffff:a.b.c.d`）は IPv4 に直してから比べる（Node.js の `net.BlockList`）。
  名前は接続のたびに引き直す（コンテナの住所は起き直すと変わる）。引くのは 2 秒まで。引けない・時間切れは断る。名前の引き直しは同時の接続の数（下）までしか重ならない。
- 一覧に無い住所からの接続は、何も読まずに閉じ、BFF に `refused` を知らせる（同じ住所は 1 分に 1 回まで。監査の記録を埋めないため）。
- 1 通の大きさは 1 MiB まで（`HL7_MAX_MESSAGE_BYTES`）。超えたら閉じる。枠の外のバイトが来たら閉じる。どちらも BFF には HL7 の本文を渡さず、`oversize`・`framing` を知らせるだけにする。
- 時間は 2 つに分ける（どちらも `HL7_READ_TIMEOUT_SECONDS`、既定 30 秒）。枠の始まりを待つ時間：接続から、または前の ACK を返してから、枠の始まりのバイトが来るまで。枠を読む時間：枠の始まりから終わりまで。どちらかを超えたら閉じる（`timeout`）。BFF の答えは 60 秒まで待つ。
- BFF の答えを待つ間は socket の読み取りを止める（溜めるのは 1 通の上限まで）。1 つの接続で複数のメッセージを順に受けてよい（受けた順に 1 通ずつ答える）。
- 同時の接続は 8 まで。超えた接続はすぐ閉じ、BFF に `busy` を知らせる（1 分にまとめて 1 回、数を添える）。
- BFF への転送：送り先は設定の `HL7_FORWARD_URL` の 1 か所だけ。移す答え（3xx）には付いていかない。proxy の環境変数は使わない（Node.js の fetch の既定）。token は `HL7_RECEIVER_TOKEN_FILE` から読み、空・読めない・32 文字未満なら起動しない。
- 受け口のログに出す外の値（住所・理由）は、14 の規則で見える形にしてから出す。HL7 の本文と token はログに出さない。

### 13. 監査の記録

操作 `hl7` を足す。行の `actorId` は `hl7-receiver`、`actorRole` は `system`、`authMode` は `hl7`、`sourceAddressUnverified` は受け口が申告した送り手の住所。

| `detail.event` | いつ | outcome |
|---|---|---|
| `refused`・`oversize`・`timeout`・`framing`・`busy`・`dropped` | 受け口の知らせ（`busy`・`dropped` は数を添える） | denied |
| `rejected` | AR を返す前 | denied |
| `received` | 解析を通った後、Orthanc を読む前。種類・MSH-3/4・MSH-10・本文の SHA-256・メッセージの ID（UUID） | success |
| `request` | Orthanc の書き換えを呼ぶ前。対象の Orthanc の ID・StudyInstanceUID・画像ごとの UID の組の一覧・前の値・予定の値・書き換えごとの ID（UUID）・メッセージの ID | success |
| `dispatch` | 仕事を作れた後。書き換えごとの ID・仕事の ID | success |
| `result` | 仕事が終わった後か、送れなかった・答えが来なかった後。書き換えごとの ID・新しい Orthanc の ID・画像ごとの確かめの結果・Orthanc の答えの要点 | success・failed・unknown・partial（outcome は failed、`detail.partial: true`） |
| `reconcile` | 解いていない書き換えを照らした・人が解いた（10） | success・failed |
| `ack` | ACK を返す前。メッセージの ID・ACK のコード・書き換えた件数・止まったメッセージを閉じたか | success（AA）・failed（AE） |

- 監査の記録の `patientId` には、書き換えの後の患者 ID を入れ、`studyInstanceUid` には対象の検査の UID を入れる。
- `detail` に入れる文字の値のうち、送り手が書いた値（MSH-3/4・MSH-10）・理由の文・Orthanc の答えの要点は、14 の規則で見える形にしてから入れる。
- `request` の前の値と予定の値（`before`・`after`）だけは、照らし合わせ（10）で Orthanc の値と比べるため、元の値のまま入れる。予定の値は 7 で 14 の字を断っているが、Orthanc から読んだ前の値には入りうる。この 2 つをログや画面に出すときは、出す側で 14 の規則を当てる。

### 14. 制御文字を見える形にする

外から来た値・Orthanc から読んだ値を、ログ・監査の記録・ACK の文・端末に出す前に、次の字を `\uXXXX` にする：C0（U+0000〜U+001F）、DEL（U+007F）、C1（U+0080〜U+009F）、
双方向の書式の字（U+061C・U+200E・U+200F・U+202A〜U+202E・U+2066〜U+2069）、行と段落の区切り（U+2028・U+2029）。
ris-emulator の #21 で指摘された「端末の制御文字の注入」と同じ類を作らないため。受け口と BFF で同じ規則にする。HL7 の値にこれらの字があれば AR にする（7 の 4）ので、Orthanc に書く値には入らない。
ACK の文は、見える形にした後で `\` を含むので、11 のとおり区切りの字をエスケープしてから入れる。

## Risks / Trade-offs

- **同じ UID で中身の違う画像ができる。** Orthanc の資料は勧めていない。元の版を受け取った機器があれば、その機器では古い患者 ID のまま残る。PIR の流れでは UID が照合の鍵なので、HL7 の道だけで受け入れる（決定 2）。
- **元の検査は戻せない**（`KeepSource: false`）。前の値は監査の記録に残るが、画素以外を元に戻すのは人の作業になる。
- **MLLP に認証は無い。** 許可の一覧は住所で絞るだけ（2）。開発の一式の内側だけに置く理由はこれ。
- **受け口と BFF の間の token** が漏れると、許可の一覧を通らずに BFF の道を呼べる（BFF の公開のポートからも届く）。token は Docker の secret にし、文書に書く。
- **A40 の途中の失敗**で、患者の検査の一部だけが書き換わることがある。送り直しても同じ MSH-10 なら前の ACK を返すので、残りは新しい MSH-10 の A40 で書き換える。
- **結果の分からない書き換え**が照らせないと、HL7 の書き換えが全部止まる。開発の一式で試す用途なので、取り違えて書くより止まるほうを選ぶ。

## Migration Plan

- 配る compose は変えないので、いまの利用者への影響は無い。
- 開発の一式は、`docker/dev/up.sh` が token の secret を作り、受け口を立てる。ris-emulator の版を `pir send` のある版（main の 3573572）に上げる。
  ris-emulator の `hl7.host` は環境変数で替えられないので、送るときに `pir send --host hl7-receiver` で受け口を名指しする。
- 戻すときは、開発の一式から受け口を外し、`HL7_RECEIVER_TOKEN_FILE` を消す（BFF の道は 404 に戻る）。
