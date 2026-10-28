# 部品の実装の決まり

この頁は、部品の HTML の構造・クラス・値を書く。tsunagi-dicom は React なので、同じ構造とクラスの名前で `src/components/ui` に組む。色と間は `src/app/globals.css` のトークンで指定し、`components.css` は使わない（ui-kit の `tokens.css` は値の写しで、画面は読み込まない）。部品を使う場面と使わない場面は [components.md](components.md)、画面ごとの並びは [screen-types.md](screen-types.md) に書く。

## 共通の書き方

- **日付と時刻：** 画面は `yyyy/MM/dd`・`HH:mm`（秒が要る記録だけ `HH:mm:ss`）。日時は `2026/10/25 23:19`。年齢は生年月日の後に「（56 歳）」。`1998-03-12`・`20261025` の形を画面に出さない。
- **性別：** 「男・女・その他・不明」。DICOM・HL7 の値（M・F・O・U）は画面に出さない。
- **氏名：** 漢字を太字、下に かな（小）。英字は詳細の「検査の情報」だけ。欄の文字種の規則は次の「入力欄」に 1 つだけ置く。
- **見出しの h1：** 20px・太字。中身は頁の名前だけ（「予約」「検査一覧」）。日付や件数は h1 に入れず、補足（`<small>`）か件数の行へ。
- **英語の誤りの原文を画面に出さない。** writing.md の型の文にし、原文は記録（ログ）に残す。
- **アイコン：** 線の絵（24 の箱・線 2px・角丸）。左のナビの項目は 3 製品とも絵を付ける。tsunagi は Lucide、ris-emulator と dicom-test-generator は同じ形の SVG を `static/icons/` に置く。

## 外枠（`.shell`）

```html
<div class="shell">            <!-- 閉じたナビは class="shell collapsed" -->
  <header class="topbar">…</header>
  <nav class="sidenav" aria-label="ページ">…</nav>
  <main class="main">…</main>
</div>
```

- 格子：列 `208px` と残り、行 `48px` と残り。閉じると列は `56px`。`.main` は 左右 24px・上 12px・下 24px、区画の間 12px（`gap`）。
- 本文の幅：`.main` の直下に型の包みを置く。一覧の型は包まない（幅いっぱい）。詳細だけの画面は `<div class="w-detail">`、入力フォームは `<div class="w-form">`、設定は `<div class="w-settings">`。どれも左寄せ（`margin` を付けない）で、中の区画の間は 12px。一覧＋右に区画・一覧＋右に詳細は `<div class="cq">` で包む（幅を問う包み。`.main` には付けない）。ログインは `.shell` を使わず、`<main class="login">` に幅 384px の枠を中央に置く。

## 上の帯（`.topbar`）

```html
<header class="topbar">
  <button type="button" class="iconbtn" data-act="nav" aria-expanded="true" aria-label="ナビを開閉する">…</button>
  <span class="brand">tsunagi-dicom</span>
  <span class="sp"></span>
  <div class="qs">…直接の検索（tsunagi だけ）…</div>
  <span class="connwrap">
    <button type="button" class="connbtn" popovertarget="conn-pop" aria-label="接続の状態を開く">接続の状態 <span class="st" data-k="ok">接続中</span></button>
    <div id="conn-pop" popover class="pop" aria-label="接続の状態">
      <h3>接続の状態</h3>
      <dl class="kv"><dt>送信先</dt><dd><b>TSUNAGI</b> <span class="st" data-k="ok">成功</span> <span class="xs label">2026/10/25 23:20</span></dd>…</dl>
      <div class="ft"><button type="button" class="btn btn-sm">接続確認</button><a class="btn btn-sm" href="/modalities">接続先を開く</a></div>
    </div>
  </span>
  <button type="button" class="iconbtn" data-act="theme" aria-label="表示をライトとダークで切り替える">…sun…moon…</button>
  <span class="div" aria-hidden="true"></span>
  <span class="who"><b>試験 管理者</b><span>admin（管理者）</span></span>
  <button type="button" class="btn btn-sm">画面ロック</button>
  <button type="button" class="btn btn-sm">ログアウト</button>
</header>
```

- 高さ 48px、地 `surface`、下に 1px `border`、間 12px。並びは上のとおりで、無い項目は詰める（dicom-test-generator と ris-emulator は `who`・画面ロック・ログアウトが無く、右端が表示）。
- 接続の状態：閉じているときの札は全体の状態 1 つ（`ok`「接続中」／`ng`「一部が接続不可」。状態そのものを読めなかったとき（401・423・通信の失敗）は、接続先が落ちているとは言えないので「確認できません」）。popover は**標準の `popover` 属性**で開く（外を押す・Esc で閉じる。自前の開け閉めを書かない）。中身は相手ごとの 種類・名前・札・時刻と、「接続確認」と接続先の画面への道。接続先の画面の表と同じ相手・同じ札。幅が 640px に満たない画面では、上の帯が横にはみ出さないよう、札の前の「接続の状態」の文字を省く（ボタンの名前は `aria-label` が持つ）。
- ris-emulator の MWL の待ち受けは popover の中に「待ち受け MWL（RIS_EMU）`listen`「待ち受け中」」。帯に住所や緑の塗りの札を出さない。tsunagi の「バックエンド：モック」も popover へ。
- 表示：絵の押しボタン 1 つ。押すたびに `html[data-theme]` を `light`・`dark` で替え、覚える（tsunagi はサーバーの利用者の設定、ris-emulator と dicom-test-generator は `localStorage`）。
- 状態：押せる物は hover で `hover` の地、押している間 `pressed`、フォーカスは 2px の `ring`。
- 検証モードの帯（tsunagi の `AUTH_MODE=dev`）だけは、上の帯の上に置いてよい（本番で出ない）。

## 左のナビ（`.sidenav`）

```html
<nav class="sidenav" aria-label="ページ">
  <p class="nav-g">業務</p>
  <a class="nav-i" href="/" aria-current="page"><svg class="ic">…</svg><span class="t">検査一覧</span></a>
  <a class="nav-i" href="/received"><svg class="ic">…</svg><span class="t">受信一覧</span><span class="cnt">2</span></a>
</nav>
```

- 幅 208px（閉じると 56px で、`.t`・`.cnt`・`.nav-g` を隠す）。項目 32px、角 4px。現在地は `aria-current="page"`・地 `selected`・左 3px の `ring`（`primary` ではない）・太字。
- クラスの名前は `.nav-g`・`.nav-i` に 1 つ（`.nav-group`・`.nav-item` は使わない）。
- 待ち：ページを切り替える間、押した項目に `aria-busy="true"` を付け、絵を待ちの印に替える。

## 見出しの行・パンくず（`.pagehead`・`.crumbs`）

```html
<nav aria-label="いまの場所"><ol class="crumbs"><li><a href="/orders">予約</a></li><li aria-current="page">RE202610250001</li></ol></nav>
<div class="pagehead"><h1>予約<small>2026/10/25</small></h1><div class="acts"><button class="btn btn-primary">予約作成</button></div></div>
```

- h1 は 20px・行 28px・太字。補足は 14px・`label`。右の `.acts` に画面の操作（主は右端に 1 つ、副は 3 つまで、危険な操作は間をあけて左）。tsunagi の検査一覧にも h1「検査一覧」を置く。

## 検索の帯・件数の行（`.searchband`・`.listhead`・`.sumrow`）

```html
<div class="sumrow" role="group" aria-label="状態の件数">
  <button type="button" class="sum" aria-pressed="true"><span>すべて</span><span class="nbr">24</span></button>
  <button type="button" class="sum" aria-pressed="false"><span class="st" data-k="plan">予定</span><span class="nbr">12</span></button>
</div>
<form class="searchband" role="search" aria-label="条件" novalidate>
  <label class="field"><span class="l">期間</span>…</label> …
  <div class="acts"><button class="btn btn-primary">検索</button><button type="button" class="btn">条件をクリア</button></div>
  <div class="more">…詳しい条件…</div>
</form>
<div class="listhead"><span class="cnt"><b>24</b> 件</span><span class="xs label">新しい順・自動更新 30 秒</span></div>
```

- 帯：地 `muted-strong`・角 6px・内 12px 16px・欄の間 12px。右に「検索」（主）と「条件をクリア」（副）の 2 つに固定（dicom-test-generator の「ワークリスト検索」は「検索」にする）。押すとすぐ絞り込む画面（tsunagi の検査一覧）は「検索」を置かず「条件をクリア」だけでよい。
- 件数の行：高さ 28px 以上を常に取る。読み込み中は件数を「—」。件数を帯の中に混ぜない。
- 状態の要約：状態が 3 つ以上の一覧だけ。押すと絞り込み、`aria-pressed`。

## 一覧の表（`.tbl`）

```html
<div class="tbl-wrap" role="region" aria-label="予約の一覧" tabindex="0">
  <table class="tbl">
    <thead><tr><th aria-sort="ascending"><button type="button">予定日時<svg class="ic">…</svg></button></th>…</tr></thead>
    <tbody><tr data-row aria-selected="true" tabindex="0">…<td><span class="main-c">試験 太郎</span><span class="sub">シケン タロウ</span></td>…</tr></tbody>
  </table>
</div>
<div class="pager"><span>1〜50 件目／全 143 件</span><div class="acts">…1 ページに 50 件…前のページ・次のページ</div></div>
```

- 行 28px（2 行の氏名・サムネイルのある表は 40px）。見出しの行 28px・地 `surface`・`position:sticky; top:0`（表の中をスクロールしても残る）。見出しは並べ替えのボタン（いまの並びは太字と矢印、`aria-sort`）。
- 列は 8 つまで。日時は 1 列（2 行にしてよい）。行の操作は 1 つまで。例外は送受信の一覧の送る側だけで、保管の確認の列を足した 9 列（下の「送受信の一覧」）。
- 選んだ行：地 `selected-strong` と 最初のセルの左 3px の `primary`、`aria-selected="true"`。**太字にしない**（幅が変わる）。行の全体を押せ、行に `tabindex="0"` を付けて Enter・Space で選べる。
- 名前の列だけ `.main-c`（太字）。補足は `.sub`（12px・`label`）。数は右寄せ（`.num`）。
- モダリティの印は 1 つの形：`<span class="mod" style="--m:var(--color-mod-ct)">CT</span>`（左 4px の色の線・地 `surface`・12px 太字）。丸の点は使わない。
- 自動更新：見ている行の位置を動かさない。新しい行は上に積まず、件数の行の右に「新着 n 件」を出し、押したら読み直す。
- ページ送り：1 ページ 50 件（20・50・100 を選べる）。5 件ほどの一覧は省く。

## 状態の札（`.st`）

```html
<span class="st" data-k="ok">送信完了</span>
```

- 12px・高さ 20px・角 3px・枠 1px、印は `::before`。文字と印を必ず持ち、色は枠と印だけ（塗らない）。暗い地でも札の文字は `foreground`、枠と印の色は暗い地の値（地との対比 3:1 以上）。
- 語と `data-k`（3 製品で 1 つ）：

| data-k | 印・色 | 語 |
|---|---|---|
| plan | ○ 灰 | 予定・送信待ち・確認待ち |
| run | ◐ warning | 実施中 |
| wait / check | ◔ warning | 送信中・受信中・確認中 |
| done | ● success | 完了（ris-emulator の予約・MPPS） |
| ok | ✓ success | 送信完了・受信完了・確認済・成功・接続中 |
| listen | ● success | 待ち受け中 |
| cancel | — 灰（取り消し線なし） | 取消 |
| stop | ■ danger | 中止 |
| ng | ✕ danger | 送信失敗・確認失敗・失敗・一部が接続不可・停止 |
| unknown | ？ danger の破線 | 結果不明 |
| note | ◇ 灰 | 知らせ（撮影済み・別の装置・照合済み・未照合） |

- HL7 の送信の状態は 送信待ち（前の通が受理されるまで送らない）・送信中・送信完了・送信失敗。MPPS は 実施中・完了・中止。英語（IN PROGRESS など）を出さない。「確認済・失敗」だけの語（送信の結果に使っていたもの）はやめ、上の語にする。

## ボタン（`.btn`）

- 高さ 32px（`.btn-sm` 28px、表の行の中 24px）・角 4px・内 0 12px。主 `.btn-primary`（地 `primary`・白い字・太字）、副 `.btn`（白い地・枠 `border-input`）、枠なし `.btn-ghost`、危険 `.btn-danger`（枠と字 `danger`。確認の窓の実行だけ `.btn-danger.fill`）。
- 状態：hover `hover`（主は `primary-hover`）／押している間 `pressed`（主は `primary-active`）で 1px 沈む／無効 `disabled`（地 `surface`・字 `label`、理由を近くに 1 行）／待ち `aria-busy="true"`（左に回る印、押せない。押した場所の横に札「送信中」）。フォーカス 2px `ring`。
- 名前は体言（glossary の使い分け 2）。「撮影して送る」「撮影して送信」は「撮影して送信」に 1 つ（用語集の「送信」）。

## 入力欄（`.field`・`.input`・`.select`）

```html
<form novalidate>
<label class="field"><span class="l">予定日<span class="req">必須</span></span>
  <input class="input w-full" type="date" aria-invalid="true" aria-describedby="err-date">
  <span class="msg" id="err-date"><svg class="ic">…</svg>予定日を入力してください。</span>
</label>
```

- 欄 32px・角 4px・**枠 `border-input`**（入力欄・選択欄・枠のボタンとも。`border` にしない。3.4:1）。項目名は上に 12px・`label`。必須は項目名の右に `.req`「必須」の 1 つだけ（赤い札にしない）。
- 誤り：フォームは `novalidate`（ブラウザの吹き出しを出さない）。誤りの欄に `aria-invalid="true"` と、欄の下の 1 行（`.msg`：印と文）を指す `aria-describedby`。欄の下の文は読み上げない（`role="alert"` を付けない）。送信のときは画面の上に誤りの件数の知らせ（`role="alert"`）を出し、最初の誤りの欄へフォーカスを移す。サーバーで見つけた誤りも、同じ欄の下に返す。
- 氏名の欄の文字種（3 製品で同じ）：漢字の欄は 全角の文字と全角の空白、かなの欄は 全角のカタカナと長音・全角の空白、英字の欄は 半角の英字と `^`・空白（DICOM の PN の成分）。合わないときの文は「氏名（かな）は全角のカタカナで入力してください。」の型。
- 保存：設定の頁で 1 つの値を替える欄（選択欄・切り替え。ビューア設定の標準など）は、すぐ保存し、欄の横に「保存しました」の札を 3 秒出す。入力が複数ある作成・登録は、操作の行の保存（主）で保存する。

## 区画（`.sec`）・項目名と値（`.kv`）・操作の行（`.formbar`）

```html
<section class="sec"><h2 class="hd">送信先<span class="acts"><button class="btn">追加</button></span></h2><div class="in">…</div></section>
<dl class="kv"><dt>予定日時</dt><dd>2026/10/24 09:00</dd></dl>
<div class="formbar"><span class="l label">送信後は取り消せません</span><button class="btn">キャンセル</button><button class="btn btn-primary">登録</button></div>
```

- 区画：枠 1px `border`・角 6px。見出し 14px 太字・地 `surface`・内 8px 12px。中 12px 16px。名前は `.sec > h2`・`.sec > .in` に 1 つ（`.sec-body` は使わない）。
- `.kv`：項目名 12px `label`、値 14px 太字 `value`。値の無い項目は「—」。

## 患者バナー（`.fb`）

```html
<section class="fb r2" aria-label="患者">                <!-- 詳細だけの画面は class="fb r1" -->
  <div class="nm"><div class="n">試験 太郎</div><div class="k" title="シケン タロウ">シケン タロウ</div></div>
  <div class="f pid"><div class="l">患者ID</div><div class="v mono keep">P000101</div></div>
  <div class="f birth"><div class="l">生年月日・性別</div><div class="v">1970/04/01（56 歳）男</div></div>
  <div class="f acc"><div class="l">受付番号</div><div class="v none">—</div></div>
  <div class="f dt"><div class="l">検査日時</div><div class="v">2026/10/24 09:12</div></div>
  <div class="f md"><div class="l">モダリティ・検査名</div><div class="v" title="CT 胸部 単純"><span class="mod" style="--m:var(--color-mod-ct)">CT</span> 胸部 単純</div></div>
  <div class="f end"><span class="st" data-k="ok">保管の確認 済</span></div>
</section>
```

- 形は 2 つだけ（中身で替えない）：`.r2` は幅 900px 未満の区画（tsunagi の右の詳細・ris-emulator の右の区画）で使う 2 行の格子（1 行目 氏名・患者ID・生年月日と性別、2 行目 札・受付番号・検査日時・モダリティと検査名。行 40px）。`.r1` はそれ以外のすべて（詳細だけの画面・入力フォーム・一覧の下の詳細・dicom-test-generator の緊急撮影の写し）で使う 1 行。地 `surface`・枠 1px・角 6px。
- 値の無い項目は `.v.none` で「—」。かなとモダリティ・検査名は 1 行で切り `title` に全文。患者ID・受付番号は `.keep` で切らない（収まらないときだけその行が高くなる）。
- 置き場：見出しの行の下。詳細の区画では、区画の上に固定する（区画の中をスクロールしても残る。`position:sticky; top:0`）。
- 使う画面：tsunagi の検査の詳細（右の区画 `.r2`・詳細の画面 `.r1`）、ris-emulator の予約の右の区画（`.r2`）・予約の詳細と照合（`.r1`）、dicom-test-generator のワークリストの詳細と撮影（`.r1`）。dicom-test-generator の緊急撮影は、入力した値の写しを `.r1` で操作の行の真上に置き、入力のたびに替える。ris-emulator の右の区画の 患者・患者ID・生年月日・性別 の縦の並びは、この部品に替える。
- 例外は 1 件：確かめの欄と確認の窓の中だけは、縮めた形 `.fb.r1.mini`（氏名・患者ID・生年月日と性別の 3 つ。ほかの升を置かない）を使ってよい。

## 検査の情報（`.finfo`）と UID の行（`.uidrow`）

- `.finfo`：3 列×2 行（行 40px）に 英字氏名・生年月日（和暦）・紹介医・Study ID・シリーズ数と画像数。2 列目（和暦つきの生年月日）は中身の幅、残りを 1 列目と 3 列目で分ける（折り返して行が 40px を超えない）。無い値は「—」。並びは 患者バナー → `.finfo` → Study UID の `.uidrow` → 操作の行（`.ops`）。
- `.uidrow`：`<div class="uidrow"><span class="l">Study UID</span><span class="uid">…</span><button class="btn btn-ghost btn-sm">コピー</button></div>`。SOP Instance UID は表の上に置かず、タグの表の 1 行目に (0008,0018) を固定し、その行にコピーを置く。dicom-test-generator の送信ジョブの詳細にも Study UID の行を足す（受け手で探す鍵）。

## 一覧＋右に区画・一覧＋右に詳細の幅

- 一覧＋右に区画（`.split-h`）：右の区画 360px。**本文が 1000px に足りないときは、右の区画を一覧の下へ回す**（`.cq` の包みの中に置き、`@container (max-width:1000px)` で切り替える）。
- 一覧＋右に詳細（`.stud`）：一覧の最小 440px、詳細の最小 400px、既定は 45:55（境目で動かし、位置を覚える。動かした一覧の幅は `.stud` の `--lw` に px で入れる）。本文が 852px（440＋12＋400）に足りないときは左右に分けず、詳細を一覧の上に重ねる。選んだ行の日時は 2 行（日付／時刻）にして切らない。

## 接続先の表（`.conn`）

- 区画 `.sec` に `<h2 class="hd">` と右の「すべて接続確認」（副）、登録できる製品だけ「追加」。表 `.tbl.conn`：名称・種類（DICOM／HL7）・AEタイトル（HL7 は「—」）・ホスト名:ポート番号・最後の接続確認（`td.res`）・操作。
- 結果：未確認「—」／確認中 `<span class="st" data-k="check">確認中</span>`＋その行のボタンを `disabled`／成功 `ok`「成功」＋時刻／失敗 `ng`「失敗」＋時刻＋`<span class="why">理由の 1 句</span>`（応答がありません・接続を断られました・AEタイトルが合いません・ホスト名を引けません）。押した直後は区画の上に知らせ（何が起きたか・なぜか・次にすること）。表の列が「なぜか」だけで「次にすること」を持たないのは writing.md の狭い場所の決まりの例外で、次にすることは知らせの側に書く。
- 待ち受けは区画「待ち受け」に `.kv`（MWL・名前・`listen`「待ち受け中」・住所）。

## 送受信の一覧

- 上から `.sumrow` → `.searchband`（期間〔今日・昨日・過去7日・期間を指定〕・相手・患者ID と氏名）→ 上限の知らせ（`.notice[data-k=warn]`）→ `.listhead` → `.tbl` → `.pager`（50 件）。送る側は `.split-v` で下に詳細。
- 列の順：日時・相手（送信先／送信元 AE）・患者ID・氏名・モダリティと検査名・画像数・状態・（送る側だけ）保管の確認・操作。
- 期間の中の件数が 1,000 件を超えたら「受信が 1,000 件を超えたため、新しい 1,000 件だけを出しています。期間を狭めてください。」（送る側は「送信ジョブが…」）。

## 知らせ（`.notice`）・空の状態（`.empty`）・確認の窓（`dialog.dlg`）

```html
<div class="notice" data-k="ok" role="status"><svg class="ic">…</svg><div>試験 太郎（P000101）の 412 画像を TSUNAGI へ送信しました。</div></div>
<div class="empty"><b>条件に合う予約はありません。</b><span>条件を変えるか、「条件をクリア」を押してください。</span><button class="btn">条件をクリア</button></div>
<dialog class="dlg" aria-labelledby="t1"><h3 id="t1">予約 RE202610250001（試験 太郎）を取消にしますか？</h3><p>…</p><div class="ft"><button class="btn" autofocus>キャンセル</button><button class="btn btn-primary">取消にする</button></div></dialog>
```

- 知らせ：左 4px の状態の色（`ok`・`warn`・`err`・`info`）・印・文。画面の上の誤りだけ `role="alert"`、ほかは `role="status"`。結果の文には 患者（氏名と ID）・相手・枚数を入れる。`.error`・`.notice-error` は使わず、これに揃える。
- 空の状態：表の枠と見出しの行を残し、その下に `.empty`（1 行目 事実・2 行目 次の手・操作 1 つまで）。`.empty-box` と `.empty` を混ぜない。権限の無い頁は `.empty.denied`：「この画面は管理者のみ利用できます。」／「管理者に役割の変更を頼んでください。」／「検査一覧へ」。黙って別の頁へ移さない。
- 確認の窓：**標準の `dialog`**（`showModal()`）。題は「対象＋動詞」の疑問、本文は 何が・どうなる・戻せるか（ris-emulator は送る HL7 の種類も）。キャンセルを左・初期のフォーカス、実行を右。ris-emulator の照合・完了・取消・中止に入れる。
- 確かめの使い分け：理由や再認証を書かせる確かめは区画の中の欄（開いたらその欄へスクロールとフォーカス）。理由の要らない最後の 1 回は確認の窓。権限・役割の変更は必ず確認の窓。
