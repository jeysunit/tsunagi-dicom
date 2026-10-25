# Proposal

## Why

`add-hl7-patient-update-receiver` で、RIS の ADT^A40・ADT^A08・ORM^O01（NW）を受けて Orthanc の検査を書き換えられるようにした。PIR の試験には、まだ 2 つの場面が足りない。

- 照合の後も、モダリティが仮の患者 ID のまま同じ Study で撮り続ける（IHE PIR の Case 6）。A40 は受けた時点の検査だけを書き換えるので、後から届いた画像は仮の患者 ID のまま残り、同じ StudyInstanceUID の検査が 2 件並ぶ（検査一覧の引き当てが 409 になる）。
- RIS が予約を取消・中止したときの ORM（ORC-1 が CA・DC。RAD-13）を、いまは AR で断っている。ris-emulator が CA・DC を送るようになるので、受ける側が要る。

2026-10-25 に承認者が、spec 3.5 の範囲を広げることを決めた（PIR の順 5）。

## What Changes

- ORM の ORC-1 に `CA`・`DC`・`XO` を受ける。CA・DC は検査と画像を消さずに、受付番号を外す。XO は NW と同じく受付番号を入れる。
- A40 と ORM を受理したときに、旧い患者 ID と統合した先・書き換えた検査・ORM の検査と受付番号を、監査の記録の `ack` の行に覚える。覚えは受理から 24 時間だけ使う。
- BFF に `POST /api/hl7/sweep` を足す。`/api/hl7/messages` と同じ token で受け口だけを通し、覚えのある仮の患者 ID の検査のうち、StudyInstanceUID が覚えにあり、届き終えたものを、A40 と同じ書き方で統合した先の患者に書き換える。
- 受け口が `/api/hl7/sweep` を定期に呼ぶ（既定 60 秒、`HL7_SWEEP_INTERVAL_SECONDS`）。受け口が止まっていた間に届いた画像は、起き直した後の最初の呼び出しで拾う。
- `Backend` に、検査が届き終えたか（Orthanc の `IsStable`）を読む `studyIsStable` を足す。

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `hl7-patient-update`: ORM の CA・DC・XO、照合の後に届く画像の書き換え

## Impact

- コード：`src/lib/hl7/update.ts`・`src/lib/hl7/apply.ts`・`src/lib/hl7/sweep.ts`（新規）・`src/app/api/hl7/sweep/route.ts`（新規）・`src/lib/backend/types.ts`・`http.ts`・`mock.ts`・`hl7-receiver/main.ts`・`hl7-receiver/sweep.ts`（新規）
- 試験：`tests/unit/hl7-case6.test.ts`・`hl7-sweep-route.test.ts`（新規）、`tests/unit/helpers/fake-orthanc.ts`（新規）、`hl7-message.test.ts`・`hl7-apply.test.ts`・`hl7-http-backend.test.ts`
- 文書：`docs/spec.md` の 3.5、`docs/security-and-maintenance.md`、`hl7-receiver/README.md`
- データベース：変えない（覚えは監査の記録の `ack` の行の `detail` に入れる）
- 配る compose：変えない（受け口は開発の一式だけ）
