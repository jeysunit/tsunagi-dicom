# HL7 の受け口

MLLP の枠を BFF に渡す小さな受け口。HL7 の解析・Orthanc の更新・監査の記録・ACK の組み立ては BFF が行う。[仕様の 3.5](../docs/spec.md#hl7-patient-update) を見る。

Node.js 24 で `node hl7-receiver/main.ts` として動く。依存の包みは要らない。イメージはリポジトリの直下で `docker build -f hl7-receiver/Dockerfile .` として作る。root でない利用者で動き、アプリのファイルへの書き込みは要らない。読み取りだけのファイルシステムで使える。

| 設定 | 既定・意味 |
|---|---|
| `HL7_LISTEN_HOST` | `0.0.0.0` |
| `HL7_LISTEN_PORT` | `2575` |
| `HL7_ALLOWED_SOURCES` | 必須。空白かカンマで区切った IP・CIDR・名前。空なら起動しない。名前は接続ごとに引き直す |
| `HL7_FORWARD_URL` | 必須。BFF の `/api/hl7/messages` の URL |
| `HL7_RECEIVER_TOKEN_FILE` | 必須。BFF と同じ token のファイル。末尾の改行を除いて 32 文字以上。secret として渡す |
| `HL7_MAX_MESSAGE_BYTES` | `1048576`（1 MiB） |
| `HL7_READ_TIMEOUT_SECONDS` | `30`。接続・前の ACK から枠を待つ時間と、枠の開始から終わりまでの時間。それぞれに上限を置く |
| `HL7_FORWARD_TIMEOUT_SECONDS` | `60`。BFF の応答を待つ時間 |
| `HL7_MAX_CONNECTIONS` | `8` |
| `HL7_SWEEP_URL` | `HL7_FORWARD_URL` と同じ場所の `sweep`（`/api/hl7/sweep`）。照合の後に届いた画像の書き換えを頼む先 |
| `HL7_SWEEP_INTERVAL_SECONDS` | `60`。上の道を呼ぶ間（起きてから 5 秒後に 1 回目）。前の呼び出しが終わるまで次を呼ばない |

MLLP に認証は無い。待ち受けは開発の一式の内側に置き、ホストにはポートを出さない。起動の設定は自分で渡す。配る compose には含めない。BFF の道は公開のポートからも届くので、token を読める相手を絞る。[安全と保守の方針](../docs/security-and-maintenance.md#hl7-の受け口) に注意を書く。

許可しない住所・大きすぎる本文・時間切れ・枠の誤りは、本文を記録せず BFF に知らせる。同じ住所の拒否の知らせは 1 分に 1 回まで。BFF が答えないとき、誤りを返すとき、ACK の形が違うときは、ACK を返さず接続を閉じる。SIGTERM では新しい接続を止め、処理中の接続が閉じるのを待つ。

BFF には token のファイルと `HL7_PATIENT_ID_ISSUER`（受ける CX-4 namespace ID）を両方設定する。名前の引き当ては2秒で打ち切る。不正な許可の項目があれば起動しない。
