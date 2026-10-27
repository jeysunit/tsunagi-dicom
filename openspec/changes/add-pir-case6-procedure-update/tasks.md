# Tasks

## 1. 仕様

- [x] 1.1 `docs/spec.md` の 3.5 に、ORM の CA・DC・XO と照合の後に届く画像の書き換えを足し、`docs/security-and-maintenance.md` と `hl7-receiver/README.md` を直す

## 2. ORM の CA・DC・XO

- [x] 2.1 `src/lib/hl7/update.ts` で ORC-1 の NW・CA・DC・XO を受け、`apply.ts` で CA・DC は受付番号を外し、XO は NW と同じにする。`tests/unit/hl7-message.test.ts`・`hl7-case6.test.ts` で、受ける・断る ORC-1、CA・DC の書き換え、受付番号と患者 ID の違い、送り直しを確かめる

## 3. 照合の後に届く画像

- [x] 3.1 A40 と ORM の受理で `ack` の行に覚えを入れる
- [x] 3.2 `Backend` に `studyIsStable` を足し（`http.ts`・モック）、`tests/unit/hl7-http-backend.test.ts` で確かめる
- [x] 3.3 `src/lib/hl7/sweep.ts` に見回り（design.md の 15）を書き、確かめを同じ StudyInstanceUID の全部の検査で行うようにする。`tests/unit/helpers/fake-orthanc.ts` の画像ごとの Orthanc で、`tests/unit/hl7-case6.test.ts` に、書き換える場面と書き換えない場面（別の患者・覚えに無い検査・期限の外・2 段・先が決まらない・氏名の違い・同じ UID の別の患者・届き終えていない・最中に届いた・止まっていた間に届いた・結果不明・検証モード・同時に届く）を足す
- [x] 3.4 `POST /api/hl7/sweep` と、受け口の定期の呼び出しを足し、`tests/unit/hl7-sweep-route.test.ts` で token・設定の無いとき・重ねない呼び出し・誤りの続く BFF を確かめる
- [x] 3.5 取り違えの経路を塞ぐ（design.md の 15.1・15.3・15.4）。A40 で書き換えた検査は統合した先に残っているときだけ使う（人の書き戻しを統合し直さない）、画像の患者 ID を確かめる、HL7 の行を鍵つきの値とつなぎで確かめる（`tests/unit/hl7-history.test.ts`）、`KeepSource: false` をやめて元の画像を名指しで消す（`Backend.deleteStudyInstances`）。結合の試験（`tests/integration/orthanc.spec.ts` の 19）で、本物の Orthanc に書き換えの最中に画像を送る
- [x] 3.6 付け替えの印（design.md の 15.4）。`deploy/orthanc/tsunagi-lock.lua` の `ReceivedCStoreInstanceFilter` で、印のある検査と同じ StudyInstanceUID の C-STORE を `0xA700` で断る。`Backend` に `lockStudy`・`unlockStudy`・`studyInstanceOrigins` を足し（`http.ts`・モック）、`apply.ts` で患者 ID の変わる書き換えの前に印を付け、期限を延ばし、終わったら・失敗したら外す。元を消す前に `ModifiedFrom` を確かめる。開発の一式と結合の試験の Orthanc に `LuaScripts`・`UserMetadata` を足す。`tests/unit/hl7-lock.test.ts`・`hl7-http-backend.test.ts` と、結合の試験の 19（最中の C-STORE は断られ、印が外れた後の送り直しは保存される。REST で届いた画像は残り部分反映）・20（Lua が印の間だけ断る）・21（`ModifiedFrom` が合わなければ元を消さない）で確かめる

## 施設の Orthanc に入れるときの手順の案

配る compose（`deploy/compose.yaml`）と施設の Orthanc の設定は、この change では変えない。入れるときは、tsunagi-dicom の版を上げる前に、次の順で行う（Orthanc の再起動が要る）。

1. 入れる前に確かめる：施設の Orthanc の版（1.10.0 以上。`ReceivedCStoreInstanceFilter` が要る）と、`CheckRevisions` が false であること。
2. `deploy/orthanc/tsunagi-lock.lua` を Orthanc から読める場所に置き、設定に `"LuaScripts": ["<置いた場所>"]` と `"UserMetadata": {"TsunagiLock": 1024}` を足す（1024 がほかの利用者のメタデータで使われていれば、空いている番号にする）。`OverwriteInstances` は `true` のまま。
3. Orthanc を再起動する（再起動の間は C-STORE を受けない。装置の送信の少ない時間に行う）。ログに Lua の読み込みの誤りが無いことを確かめる。
4. 確かめ：架空の患者の検査を 1 件送り、その検査に `PUT /studies/{id}/metadata/TsunagiLock`（値はいまの UNIX 秒＋60）を付けて、同じ StudyInstanceUID の画像を C-STORE で送ると断られ（`0xA700`）、ログに `tsunagi-lock: refused` が出ることを見る。印を `DELETE` で外して送り直すと受けることを見る。最後に試験の検査を消す。
5. 取り込みの速さを測る：ふだんの量の検査を送り、入れる前と比べる。
6. tsunagi-dicom の版を上げる。A40 を 1 通流し、監査の記録の `result` が成功し、印が外れている（`GET …/metadata/TsunagiLock` が 404）ことを見る。

戻すとき：tsunagi-dicom を前の版に戻すだけなら、Orthanc の Lua は残してよい（印が付かなければ何も断らない）。Lua を外すときは、設定から 2 つを消して Orthanc を再起動する。印が残っていても、Lua が無ければ何も断らない。

## 4. 確かめ

- [x] 4.1 lint・型・Vitest が合格することを確かめる
- [ ] 4.2 開発の一式で、照合の後の追加撮影（Case 6）と取消の ORM を通しの試験（`tests/flow/flow.spec.ts`）で確かめる（PIR の順 5 の 4。別の PR）
- [ ] 4.3 CI が緑であることを確かめる

## Workflow follow-up

- PR のレビューの後に、この change を archive する
