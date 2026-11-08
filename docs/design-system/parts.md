# 部品の実装の決まり

この頁は、部品の HTML の構造・クラス・値を書く。tsunagi-dicom は React なので、同じ構造とクラスの名前で `src/components/ui` に組む。色と間は `src/app/globals.css` のトークンで指定し、`components.css` は使わない（ui-kit の `tokens.css` は値のコピーで、画面は読み込まない）。部品を使う場面と使わない場面は [components.md](components.md)、画面ごとの並びは [screen-types.md](screen-types.md) に書く。

## 共通の書き方

- **日付と時刻：** 画面は `yyyy/MM/dd`・`HH:mm`（秒が要る記録だけ `HH:mm:ss`）。日時は `2026/10/25 23:19`。生年月日は西暦の後ろの括弧に元号と年・年齢を並べる（`1975/05/14（昭50・51歳）`。一覧の表の列は `1975/05/14 (S50・51歳)`。下の「生年月日と和暦」）。`1998-03-12`・`20261025` の形を画面に出さない。
- **性別（ui-kit 1.2.5）：** 値は M・F・O・U の 4 つで、医療システム共通。画面と製品の中の値は `U` を使い、画面の表示は「男・女・その他・不明」。値が空のとき・4 つの外の値のときも「不明」と出す（空のまま何も出さない画面を作らない）。DICOM・HL7 の値は画面に出さない。
  - **HL7 v2：** `U` のまま書き、読む。
  - **DICOM に書くとき：** `U` は空にして書く。Patient's Sex (0010,0040) の列挙値は M・F・O の 3 つだけで、`U` は規格に無い。
  - **DICOM から読むとき：** 空と、M・F・O 以外の値は `U` と読む。
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
- 縦のスクロールバーの場所を空けておく（ui-kit 1.2.7）：`html { scrollbar-gutter: stable }`。部品集では `components.css` が持つ。tsunagi は `components.css` を読まないので、`globals.css` に同じ 1 行を持つ（部品集の parts.md の「1.2.7 を写したら消す」は、`components.css` を読む製品に当たる）。
- 本文の幅：`.main` の直下に型の包みを置く。一覧の型は包まない（幅いっぱい）。詳細だけの画面は `<div class="w-detail">`、入力フォームは `<div class="w-form">`、設定は `<div class="w-settings">`。どれも左寄せ（`margin` を付けない）で、中の区画の間は 12px。一覧＋右に区画・一覧＋右に詳細は `<div class="cq">` で包む（幅を問う包み。`.main` には付けない）。ログインは `.shell` を使わず、`<main class="login">` に幅 384px の枠を中央に置く。

## 上の帯（`.topbar`）

```html
<header class="topbar">
  <button type="button" class="iconbtn" data-act="nav" aria-expanded="true" aria-controls="sidenav" aria-label="ナビを開閉する" title="ナビを閉じる"><svg class="ic" aria-hidden="true"><use href="#i-menu"/></svg></button>
  <span class="brand">tsunagi-dicom</span>
  <span class="sp"></span>
  <div class="qs">…直接の検索（tsunagi だけ）…</div>
  <span class="connwrap">
    <button type="button" class="connbtn" popovertarget="conn-pop"><span class="cl">接続の状態</span><span class="st" data-k="ok">接続中</span><svg class="ic chev" aria-hidden="true"><use href="#i-chevd"/></svg></button>
    <div id="conn-pop" popover class="pop" aria-label="接続の状態">
      <h3>接続の状態</h3>
      <dl class="kv"><dt>送信先</dt><dd><b>TSUNAGI</b> <span class="st" data-k="ok">成功</span> <span class="xs label">2026/10/25 23:20</span></dd>…</dl>
      <p class="sr" role="status" aria-live="polite">…手で押した「接続確認」の結果だけをここに入れる…</p>
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
- **ナビの開閉ボタン：** ハンバーガー（Lucide の `menu`。tsunagi は `lucide-react` の `Menu` をそのまま使う）に固定し、開閉で絵を替えない（状態は `aria-expanded` が持つ）。読み上げの名前は「ナビを開閉する」で固定し、`aria-expanded` と `aria-controls="sidenav"`（ナビの `id`）を付ける。大きさは 32px（`.iconbtn`）。ホバーの `title` だけ「ナビを閉じる」「ナビを開く」で替えてよい。
- **接続の状態：** 枠つき 32px のボタン `.connbtn` の中に、「接続の状態」（`.cl`。本文の色）・全体の状態の札（`.st`）・シェブロン（`.chev`。下向き、開くと上向き）を左からこの順で置く。全体の語は次の 5 つだけで、色だけに頼らず文字と印を添える。

  | 語 | `data-k` | いつ |
  |---|---|---|
  | 確認中 | `check` | 読み込み中 |
  | 接続中 | `ok` | 確認できる相手のすべてが成功 |
  | 一部が接続不可 | `ng` | 1 つでも失敗 |
  | 未確認 | `plan` | まだ 1 つも確認していない（tsunagi は、この役割には全体の状態を返さないとき） |
  | 確認できません | `unknown` | 状態を読めない（401・423・通信の失敗。接続先が落ちているとは言えない） |

  popover は**標準の `popover` 属性**で開く（外を押す・Esc で閉じる。自前の開け閉めを書かない）。ボタンに `aria-label` を付けない（見える文字が名前になる）。640px 未満は `.cl`（「接続の状態」の文字）を視覚的に隠す（読み上げの名前は残る）。
- 接続の状態の読み上げ：1 分ごとに再取得して替わる札は読み上げない（`aria-live` を付けない）。手で押した「接続確認」の結果だけを、popover の中の `<p class="sr" role="status" aria-live="polite">` に文で入れて読み上げる（閉じると読まれない）。
  - 結果の文は次の 3 つの型の 1 文だけ。全部できた：「N 件すべてに接続できました。」／一部できなかった：「N 件のうち M 件に接続できませんでした。」（M は失敗の件数、N は確認した件数）／確認できなかった：「接続を確かめられませんでした。」（状態を読めない・通信の失敗）。N には状態を持たない相手を数えない。結果を入れる前に `<p>` の中身を空にして、同じ文が続いても読み上げ直されるようにする。
- 状態を持たない相手（確認する手段が無い相手）には札を出さず、素の「—」（補助の色 `label`）を置く。「未確認」の札にしない。全体の札の語の判定には数えない。「確認できる相手」が 0 件なら「未確認」。確認できる相手でまだ確認していないときは札「未確認」（`plan`）。接続先の表の結果欄も同じ。tsunagi の接続先はどれも C-ECHO で確認できるので、素の「—」にする相手は無い。
- 接続の状態の中身：相手ごとの 種類・名前・札・時刻と、「接続確認」と接続先の画面への道。接続先の名前は太字（`<b>`）、状態の札、時刻（`.xs.label`）の順で `dd` に並べる。接続先の画面の表と同じ相手・同じ札。
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
- 列は 8 つまで。日時は 1 列（2 行にしてよい）。行の操作は 1 つまで。例外は送受信の一覧の送る側だけで、保管の確認の列を追加した 9 列（下の「送受信の一覧」）。
- **日時と生年月日の列は 2 行にして狭くする（検査一覧）。** どちらも 12px・行間 14px の 2 行にして、行の高さ（28px）を変えない。検査日時（予約は予定日時）は 1 行目 `2026/10/25`、2 行目 `23:19`（2 行目は `label` の色）。生年月日は 1 行目 西暦 `1975/05/14`、2 行目 括弧から後ろ `(S50・51歳)`。生年月日は、括弧から後ろを `<span class="unit">`（`inline-block`）で包み、西暦と括弧の間だけで折れ、括弧の中では折れないようにする（患者バナーの生年月日と同じ作り）。列の幅の目安は 検査日時 84px、生年月日 104px（セルの左右の余白を含む）。これで 1280 幅（左のナビあり・詳細を閉じた）の検査一覧が、横にスクロールせずにモダリティの札と検査名の頭まで見える。
- 選んだ行：地 `selected-strong` と 最初のセルの左 3px の `primary`、`aria-selected="true"`。**太字にしない**（幅が変わる）。行の全体を押せ、行に `tabindex="0"` を付けて Enter・Space で選べる。
- 名前の列だけ `.main-c`（太字）。補足は `.sub`（12px・`label`）。数は右寄せ（`.num`）。
- モダリティの印は 1 つの形：`<span class="mod" style="--m:var(--color-mod-ct)">CT</span>`（左 4px の色の線・地 `surface`・12px 太字）。丸の点は使わない。
- 自動更新：見ている行の位置を動かさない。新しい行は上に積まず、件数の行の右に「新着 n 件」を出し、押したら再取得する。
- ページ送り：1 ページ 50 件（20・50・100 を選べる）。5 件ほどの一覧は省く。

## 状態の札（`.st`）

```html
<span class="st" data-k="ok">送信完了</span>
```

- 12px・高さ 20px・角 3px・枠 1px、印は `::before`。文字と印を必ず持ち、色は枠と印だけ（塗らない）。暗い地でも札の文字は `foreground`、枠と印の色は暗い地の値（地との対比 3:1 以上）。
- 語と `data-k`（3 製品で 1 つ）：

| data-k | 印・色 | 語 |
|---|---|---|
| plan | ○ 灰 | 予定・送信待ち・確認待ち・未確認・インポート待ち |
| run | ◐ warning | 実施中 |
| wait / check | ◔ warning | 送信中・受信中・確認中（読み込み中）・インポート中 |
| done | ● success | 完了（ris-emulator の予約・MPPS） |
| ok | ✓ success | 送信完了・受信完了・確認済・成功・接続中 |
| listen | ● success | 待ち受け中 |
| cancel | — 灰（取り消し線なし） | 取消 |
| stop | ■ danger | 中止 |
| ng | ✕ danger | 送信失敗・確認失敗・失敗・一部が接続不可・停止 |
| skip | — warning | 対象外・除外（インポートで送らない行。下の「ファイルを選ぶ部品」。失敗 ✕ とは印と色の両方で分ける） |
| unknown | ？ danger の破線 | 結果不明・確認できません（接続の状態を読めない） |
| note | ◇ 灰 | 知らせ（撮影済み・別の装置・照合済み・未照合・インポート） |

- HL7 の送信の状態は 送信待ち（前の通が受理されるまで送らない）・送信中・送信完了・送信失敗。MPPS は 実施中・完了・中止。英語（IN PROGRESS など）を出さない。「確認済・失敗」だけの語（送信の結果に使っていたもの）はやめ、上の語にする。

### 小さな印（`.badge`）

```html
<span class="badge">新着</span>
```

- 状態ではない小さな印（「標準」「新着」）。「インポート」は状態ではない知らせなので、`.badge` でなく `.st` の `note`（検査一覧・受信一覧とも）。12px・高さ 20px・角 3px・枠 1px `border`・字 `label`・左右の余白 6px。印の形（○ ✓ など）を持たず、色も使わない。状態は `.st` で、`.badge` に状態の意味を持たせない。必須は `.req`（入力欄の節）、モダリティは `.mod`。「標準」「新着」の作りが部品ごと・画面ごとに分かれていたのを、これ 1 つにする。

## ボタン（`.btn`）

- 高さ 32px（`.btn-sm` 28px、表の行の中 24px）・角 4px・内 0 12px。主 `.btn-primary`（地 `primary`・白い字・太字）、副 `.btn`（白い地・枠 `border-input`）、枠なし `.btn-ghost`、危険 `.btn-danger`（枠と字 `danger`。確認の窓の実行だけ `.btn-danger.fill`）。tsunagi の Button では `.btn-danger` が `variant="danger-outline"`、`.btn-danger.fill` が `variant="danger"`。
- 状態：hover `hover`（主は `primary-hover`）／押している間 `pressed`（主は `primary-active`）で 1px 沈む／無効 `disabled`（地 `surface`・字 `label`、理由を近くに 1 行）／待ち `aria-busy="true"`（左に回る印、押せない。押した場所の横に札「送信中」）。フォーカス 2px `ring`。
- 最小幅：`.btn` は 64px、`.btn-sm` は 48px（「開く」「閉じる」のように字数の少ない名前でも、押す的を狭くしないため）。tsunagi の Button は `min-w-16`（標準）・`min-w-12`（小）で同じ値を持つ。
- `hidden` 属性：部品集の `components.css` は `[hidden]{display:none!important}` を持つ。tsunagi は React で、隠す部品は描かないか Tailwind の `hidden` で隠し、`display` を持つ部品に `hidden` 属性を付けない。
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
  <div class="f birth"><div class="l">生年月日・性別</div><div class="v" title="1970/04/01（昭45・56歳）男">1970/04/01<span class="unit">（昭45・56歳）男</span></div></div>
  <div class="f acc"><div class="l">受付番号</div><div class="v none">—</div></div>
  <div class="f dt"><div class="l">検査日時</div><div class="v">2026/10/24 09:12</div></div>
  <div class="f md"><div class="l">モダリティ・検査名</div><div class="v" title="CT 胸部 単純"><span class="mod" style="--m:var(--color-mod-ct)">CT</span> 胸部 単純</div></div>
  <div class="f end"><span class="st" data-k="ok">保管の確認 済</span></div>
</section>
```

- 形は 2 つだけ（中身で替えない）：`.r2` は幅 900px 未満の区画（tsunagi の右の詳細・ris-emulator の右の区画）で使う 2 行の格子（1 行目 氏名・患者ID・生年月日と性別、2 行目 札・受付番号・検査日時・モダリティと検査名。行 40px）。`.r1` はそれ以外のすべて（詳細だけの画面・入力フォーム・一覧の下の詳細・dicom-test-generator の緊急撮影のコピー）で使う 1 行。地 `surface`・枠 1px・角 6px。
- 狭い区画の形 `.fb.r2.narrow`（ui-kit 1.2.2。入れ物の内側が 400px 未満のとき、`class="fb r2 narrow"`）：tsunagi の右の詳細は最小 440px（内側 414px 以上）で、1000〜1440px の幅で実測してもバナーの値は切れない（和暦は生年月日の括弧の中に並べる）。400px 未満の区画に `r2` を置く画面が出たら、そこで `narrow` を追加する。
- 値の無い項目は `.v.none` で「—」。かなとモダリティ・検査名は 1 行で切り `title` に全文。患者ID・受付番号は `.keep` で切らない（収まらないときだけその行が高くなる）。
- 保存先：見出しの行の下。詳細の区画では、区画の上に固定する（区画の中をスクロールしても残る。`position:sticky; top:0`）。
- 使う画面：tsunagi の検査の詳細（右の区画 `.r2`・詳細の画面 `.r1`）、ris-emulator の予約の右の区画（`.r2`）・予約の詳細と照合（`.r1`）、dicom-test-generator のワークリストの詳細と撮影（`.r1`）。dicom-test-generator の緊急撮影は、入力した値のコピーを `.r1` で操作の行の真上に置き、入力のたびに替える。ris-emulator の右の区画の 患者・患者ID・生年月日・性別 の縦の並びは、この部品に替える。
- 例外は 1 件：確認欄と確認の窓の中だけは、縮めた形 `.fb.r1.mini`（氏名・患者ID・生年月日と性別の 3 つ。ほかの升を置かない）を使ってよい。

## 生年月日と和暦

**生年月日は、西暦の後ろの括弧に「元号の漢字 1 字と年・年齢」を並べて出す。** DICOM・HL7・CSV・API の値・ログは西暦のまま。和暦は画面の表示だけに使う。

| 表記 | 使う場面 | 形 | 例 |
|---|---|---|---|
| 漢字 1 字（基本） | 患者バナー（`.r1`・`.r2`・`.r1.mini`）、確認欄と確認の窓 | `yyyy/MM/dd（元号の漢字 1 字＋年・年齢歳）` に性別 | `1975/05/14（昭50・51歳）男` |
| 英字 1 字（枠が狭い） | 一覧の表の生年月日の列 | `yyyy/MM/dd (元号の英字 1 字＋年・年齢歳)`。括弧は半角で、前に半角の空白を 1 つ置く | `1975/05/14 (S50・51歳)` |

- 元号は 明・大・昭・平・令（英字は M・T・S・H・R）。元年は短い表示では数字の `1`（`平1`・`H1`）。始まりは 明治 1868/10/23・大正 1912/07/30・昭和 1926/12/25・平成 1989/01/08・令和 2019/05/01。年 ＝ 西暦の年 − 元号の始まりの年 ＋ 1。明治より前（1868/10/22 以前）は元号を出さず、年齢だけを括弧に入れる。
- **年齢は満年齢。検査の画面は検査日の時点で数える**（開いた日で数えない。同じ検査の年齢が日によって変わらないように）。誕生日の当日に上がる。2/29 生まれは、平年は 3/1 に上がる。検査日が読めない・生年月日より前のときは、年齢を出さない。年齢の数字と「歳」の間に空白を入れない。
- 帯の値は 西暦 と 括弧から後ろ の 2 つに分け、後ろを `<span class="unit">`（`inline-block`）で包む。狭い区画で値が折れるとき、西暦と括弧の間で折れ、括弧の中では折れない。
- **一覧に年齢だけの列は置かない**（同じ値が 2 か所に出る）。詰めた一覧で生年月日の列を畳むときも年齢の列は残さず、年齢は右の患者バナーで見る。年齢の並べ替えは生年月日の列の逆向きで代える（年齢の昇順は生年月日の降順）。専用の並べ替えは作らない。
- 変換の組（元号の 12 行、年齢の境目の 7 行）は `tests/unit/japanese-date.test.ts`。

### 入力

- **基本の形は 2 つ：`1975/05/14` と `S50/05/14`。** 追加する形は 2 つ：漢字 1 字の `昭50/05/14` と、正式名の `昭和50年5月14日`。年の `1` は `元` でも受ける（`H元/01/08`・`平成元年1月8日`）。英字は大文字・小文字・全角のどれでもよい。月と日の 0 は省いてよい（`S50/5/14`）。区切りは `/`。西暦と元号を混ぜた形（`1975/S50/05/14`）は受けない。
- **欄の下に、読み取った結果を 1 行出す。** 基本の形（`1975/05/14（昭50・51歳）`）を、`.field` の `.hint` で、入力のたびに替える。読み上げは `aria-describedby` で欄に結ぶだけにし、`aria-live` は付けない（打つたびに読まれるため）。読み取れないときは `.hint` を消し、`.msg` に誤りを出す。
- 欄は 1 つ（`type="text"`・`inputmode="text"`・`autocomplete="off"`）。日付ピッカーの `type="date"` は使わない（元号を受けられないため）。保存する値は西暦の `YYYYMMDD`（DICOM の PatientBirthDate）。
- 全角で受けるのは英字だけ。全角の数字と全角の `／` は受けない。
- 誤りの文は writing.md の型（何が起きたか・なぜか・次にすること）で、対象の名前を入れる。確認する順は 形 → 元号の範囲 → 今日より後 で、最初に当たった文を 1 つ出す：
  - 形が合わない：「生年月日を読み取れません。`1975/05/14` か `S50/05/14` の形で入力してください。」上の形に当たらないもののほか、暦に無い日（`2/30`・平年の `2/29`・13 月）と元号の年の `0` もこの文。
  - 元号の範囲の外（元号の年を西暦にしてから、その日が元号の期間に入るかを見る）。終わりより後（`S64/01/08`・`H31/05/01`）：「生年月日が昭和の範囲にありません。昭和は 1989/01/07 までです。平成1年は 1989/01/08 からです。」（範囲の外の元号の正式名と、その元号の終わりの日と、次の元号の 1 年の始まりの日を入れる）。始まりより前（`H1/01/07`・`R1/04/30`）：「生年月日が平成の範囲にありません。平成は 1989/01/08 からです。昭和64年は 1989/01/07 までです。」（始まりの日と、前の元号の末年とその終わりの日を入れる）。明治の始まりより前（`M1/10/22`）は前の元号が無いので「生年月日が明治の範囲にありません。明治は 1868/10/23 からです。」の 2 文で終える。
  - 今日より後：「生年月日が今日より後です。日付を確かめてください。」（今日は、サーバーで確認するときはサーバーの時間帯の今日、画面で確認するときは画面の今日）
- 西暦で明治より前（`1860/03/03`）は誤りにしない（表示と同じく元号を出さず、`1860/03/03（166歳）`）。
- 検索の条件の生年月日も同じ入力の欄（一覧の検索で生年月日を入力するとき）。一覧の表の生年月日の列の形は、この節の上に書いた形に従う。
- この節は画面の欄の決まり。画面の欄の外から生年月日を受ける入口（CLI・API・URL の引数・HL7）は、それまで受けていた形（`YYYYMMDD`・`YYYY-MM-DD`）をそのまま受け続け、狭めない。
- **誤りの行 `.field .msg`（ui-kit 1.2.5 で決めた）：**
  1. 印は `icons.svg` の `i-alert`（Lucide の `triangle-alert`）で `danger`、文は地の色（赤にしない。長い文が読みにくい）。実装は `src/components/ui/input.tsx` の `FieldNote`。
  2. 誤りの文が 2 行以上に折れたときは、印を 1 行目にそろえる（`align-items:flex-start`。1 行のときの見た目は変わらない）。
- 読み取りの試験の組（受ける形・誤り・数える日）は `tests/unit/japanese-date.test.ts`。tsunagi-dicom の欄は 2 つ（検査一覧の詳細条件の生年月日と、患者情報修正の生年月日）で、読み取り結果の年齢を数える日は、詳細条件は開いた日、患者情報修正はその検査の検査日（docs/spec.md の 3.1「生年月日の入力」）。

## 検査の情報（`.finfo`）と UID の行（`.uidrow`）

- `.finfo`：3 列×2 行（行 40px）に 英字氏名・紹介医・Study ID・シリーズ数と画像数（5 つ目と 6 つ目の升は空ける）。生年月日の和暦は置かない（患者バナーの生年月日に並べる）。無い値は「—」。並びは 患者バナー → `.finfo` → Study UID の `.uidrow` → 操作の行（`.ops`）。
- `.uidrow`：`<div class="uidrow"><span class="l">Study UID</span><span class="uid">…</span><button class="btn btn-ghost btn-sm">コピー</button></div>`。SOP Instance UID は表の上に置かず、タグの表の 1 行目に (0008,0018) を固定し、その行にコピーを置く。dicom-test-generator の送信ジョブの詳細にも Study UID の行を追加する（受け手で探す鍵）。

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

## ファイルを選ぶ部品（`.picker`。ui-kit 1.2.6）

**DICOM のファイル・フォルダを取り込む画面は、この 1 つの区画で組む。選ぶ→件数・大きさ・患者と検査を確認する→除外（戻せる）か中止で外す→インポート、の順を変えない。** 決まりの全文（並び・数え方・列の幅・状態の語・取り消しの 3 段階・キーボードと読み上げ・焦点・理由）は、部品集 bcamp/design の `system/parts.md` の「ファイルを選ぶ部品」にあり、tsunagi はそのとおりに作る。ここには構造と、tsunagi の実装で決めたことを書く。実装は `src/components/ui/file-picker.tsx`、数え方と文言は `src/lib/import/picker-model.ts`、ブラウザでの頭の読み取りは `src/lib/import/dicom-preview.ts`。PACS の業務の画面（ログインした職員だけが開く画面）の中だけで使う（一覧に患者ID・氏名を出すため）。

```html
<section class="sec picker" aria-labelledby="pk-t" data-over="false" data-busy="false">
  <h2 id="pk-t">インポート</h2>
  <div class="in">
    <div class="pk-drop compact"><span class="t">ここにファイルまたはフォルダをドロップ</span><span class="acts"><button class="btn">ファイルを選択</button><button class="btn">フォルダを選択</button></span></div>
    <div class="listhead pk-sum"><span class="cnt"><b>43</b> 件（対象外 3・除外 1）　選択 <b>39</b> 件・19.5 MB</span><span class="acts"><button class="btn btn-ghost btn-sm">選択を解除</button></span></div>
    <div class="tbl-wrap pk-list" role="region" aria-label="選んだファイル" tabindex="0"><table class="tbl tall">
      <thead><tr><th>名前</th><th>患者ID</th><th>氏名</th><th>検査日</th><th>モダリティ</th><th>シリーズ／画像</th><th class="num">大きさ</th><th>状態</th><th><span class="sr">操作</span></th></tr></thead>
      <tbody>…</tbody>
    </table></div>
  </div>
  <div class="formbar"><span class="l label">選択 39 件・19.5 MB</span><button class="btn btn-primary">インポート</button></div>
</section>
```

- **値：** 取り込み口は枠 2px の点線 `border-input`・地 `surface`・角 6px。何も選んでいないときは縦並び・内 24px 16px、選んだ後は `.compact`（横並び・内 8px 12px）。ドロップ中は区画に `data-over="true"`、枠は実線 `primary`・地 `selected`・文は「ドロップして追加」。一覧は `.tbl.tall`（40px）で高さ 320px まで。列の幅は 患者ID 96px（等幅 13px）・氏名 128px・検査日 88px・モダリティ 72px・シリーズ／画像 80px（等幅 13px）・大きさ 96px・状態 200px・操作 72px。長い値は検査日と大きさのほか、省略せずに折り返す（`overflow-wrap:anywhere`）。
- **札：** 対象外・除外は `skip`（— `warning`）、失敗 `ng`・中止 `stop` は `danger`。この部品の中では、送らない行の札は囲み線に加えて札の字も同じ色にする（行の字は通常の色のまま）。進みは砂時計（DADS の静的インジケーター、24px、色は `primary-active`。暗い地は `link`、強制の色は `CanvasText`）と `インポート中　14 ／ 39 件`。横棒と回る輪は使わない。
- **中止：** 操作の行の「中止」は `.btn-danger`（枠と字 `danger`）。確認の窓「インポートを中止しますか？」の実行は「中止する」（`.btn-danger.fill`）。窓を開いている間は進みを止め、数を動かさない。
- **結果不明を確認する**（確認できる利用者＝管理者だけ）：結果不明の行は、そのままだと同じ検査のインポートを止め続ける。画像サーバーを見て確認できる利用者だけに、結果の後の操作の列へ「確認」（`btn-sm`。読み上げの名前は `aria-label="<ファイル名> の結果不明を確認"`）を出す。ほかの利用者には出さず、操作の列は空のまま（知らせの最後の「管理者に確かめを頼んでください。」はこの利用者だけに出す）。要求の ID と検査の UID を持たない行（BFF に届いたか分からない行）には出さない。押すと、一覧の下の別の区画に確認の欄を 1 つ出し、開いたらその欄へスクロールして「確認内容」へ焦点を置く（理由を書かせる確認は区画の中の欄。確認の窓にしない）。欄は 1 度に 1 行だけで、別の行の「確認」を押すと対象を替える（書きかけの確認内容は消す）。
  ```html
  <td class="op"><button type="button" class="btn btn-sm" aria-label="IM0007 の結果不明を確認">確認</button></td>
  <section class="sec" aria-labelledby="pk-rs-t" data-pk="resolve">
    <h2 id="pk-rs-t">結果不明の確認</h2>
    <div class="in">
      <dl class="kv"><dt>ファイル</dt><dd>IM0007</dd><dt>検査UID</dt><dd class="mono">1.2.392.200036.9116.2.6.1.48.1215474381.1698745234.123456</dd><dt>要求ID</dt><dd class="mono">3f0c9a52-6b1e-4d2a-9c47-0a1b2c3d4e5f</dd></dl>
      <label class="field"><span class="l">確認内容<span class="req">必須</span></span><input class="input w-full" type="text" maxlength="500" required></label>
    </div>
    <div class="formbar"><button type="button" class="btn">キャンセル</button><button type="button" class="btn">失敗として記録</button><button type="button" class="btn">成功として記録</button></div>
  </section>
  ```
  - **欄の中身：** 見出し「結果不明の確認」。項目は `.kv` で ファイル・検査UID・要求ID（UID と要求 ID は等幅）。入力は「確認内容」1 つ（必須・500 字まで・1 行の `.input`。画像サーバーのどこで・何を見たか）。操作の行は左から「キャンセル」「失敗として記録」「成功として記録」で、**主ボタン（`btn-primary`）は置かない**：成功と失敗のどちらも利用者が確認して決めることで、どちらかを勧める形にしない。確認内容が空のまま押すと、欄の下の `.msg` に「確認内容を入力してください。」を出して欄へ焦点を戻す。確認内容の入力は必須を読み上げに伝える（`required`、または `aria-required="true"`。欄は `<form>` の外なので、ブラウザの吹き出しは出ない）。記録を送っている間は、3 つのボタンと、ほかの行の「確認」と「続けて選択」を押せなくする（送っている最中に別の行へ移る・一覧を空に戻すと、結果が別の行の欄に当たる、または当たる先が消えるため）。「キャンセル」を押すと欄を閉じ（書きかけの確認内容は消す）、焦点を元の行の「確認」へ戻す。
  - **記録したあと：** 記録できたら、欄を閉じ、その行の札を「成功」または「失敗」に替え、`.sub` に「管理者が確認」と出し、操作の列を空にする。件数は同じ数え方で数え直す（結果不明が 1 減り、成功か失敗が 1 増える。選択の数は変わらない。結果不明が 0 になれば語を出さない）。区画の上の知らせは、数え直した件数で作り直す。管理者が記録した行を含むときは、成功の文を「選択 39 件のうち 38 件はインポート済みです（うち 1 件は管理者が確認）。」の型にする（「をインポートしました」は、記録した行を含まないときの文）。失敗にも管理者が記録した行があれば「2 件は失敗しました（うち 1 件は管理者が確認。理由は各行の状態）。」、無ければ今までどおり「2 件は失敗しました（理由は各行の状態）。」。結果不明が残る間だけ、結果不明の文「1 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。」を追加する。この 3 つを成功・失敗・結果不明の順に並べ、失敗も結果不明も無ければ `ok`、あれば `err`。中止があるときも成功の文の型だけ替える（「38 件はインポート済みです（うち 1 件は管理者が確認）。残り 25 件は中止したためインポートしていません。」）。並びは失敗と結果不明が先頭のまま。読み上げの領域に「IM0007 を成功として記録しました。結果不明 1 件。」を 1 回書く。**記録したあとの知らせには `role` を付けない**（`alert`・`status` のどちらも付けない）：付けると、同じ変化を読み上げの領域と知らせで 2 度読む。1 回だけ伝える先を読み上げの領域にしたのは、知らせの文は件数の全体を言うので長く、どの行がどう替わったかを言わないため（接続確認の結果を `role="status"` の 1 つだけに入れる決まりと同じ）。焦点は、次の結果不明の行の「確認」へ（無ければ「続けて選択」へ）。「続けて選択」を押したら、開いている欄も閉じる。
  - **記録できなかったとき：** 欄を閉じず、欄の上に `.notice`（`err`、`role="alert"`）で、何が起きたか・なぜか・次にすること（BFF の文をそのまま。例「画像サーバーにこの画像が見つかりません。成功として記録できません。」「このインポートはまだ処理中です。終わってから確認してください」。通信が切れたときは、次にすることを添えて「サーバーに接続できませんでした。時間をおいて、やり直してください」）を出す。入力は残し、焦点は「確認内容」へ戻す。行の札は、記録できたときだけ替える。
  - **成功に記録できる条件：** 画像サーバーを読み、この画像があるときだけ（BFF が読み、無いのに成功を求められたら断る）。画面は条件を先に判定せず、断られた文を出す。画像サーバーには書き込まない（画面の操作は記録だけで、取り込み直しや削除ではない）。
- **tsunagi で決めたこと：**
  - 氏名の列は、一覧の表と同じく姓と名の 2 成分を出す（`parsePatientName`。漢字の組が無ければ英字）。第 3〜5 成分は出さない（docs/patient-name-test-cases.md の規則 8）。
  - 1 件の大きさの上限は `IMPORT_MAX_MB`（BFF と同じ値）。合計の上限は持たない（BFF は 1 つの要求で 1 つのファイルを受け、読み切ってから Orthanc へ渡すため）。
  - 送る中身（1 件ずつの `POST /api/import`）は部品の外（画面の側）が持ち、部品は選んだものの数え方・並び・状態・焦点・読み上げを持つ。「失敗だけをもう一度」は持たない。
  - 「インポート」を押した後の確認の窓は挟まない。もうある画像・検査への取り込みは BFF が断る（docs/spec.md の 3.5「取り込み」）ので、取り込みで既存のデータは変わらない。
  - **状態「結果不明」を追加した**（2026-11-05。部品集に追加した。確認して記録する形は上の「結果不明を確認する」）。BFF は、画像サーバーの答えが分からないとき結果不明を返し、状態の確認でも決まらなければ結果不明のまま残す（docs/spec.md の 3.5「結果不明」）。この行を成功と数えると取りこぼしを見落とし、失敗と数えると選び直して同じ画像を入れ直させるので、どちらにも数えない。札は「状態の札」の表の `unknown`（？ `danger` の破線）で、札の字も `danger`。理由の 1 句を札の下に出す。数え方は **選択 ＝ 成功 ＋ 失敗 ＋ 結果不明 ＋ 中止**（結果不明が 0 件のときは語を出さない）。操作の行の左は `選択 39 件 → 成功 37・失敗 1・結果不明 1`。並びは失敗と同じ（一覧の上）。結果の知らせは `err`（`role="alert"`）で、writing.md の「結果不明」の形の文を追加する：「1 件は、画像サーバーに入ったか分かりません（各行の状態）。確かめるまで、同じ検査はインポートできません。管理者に確かめを頼んでください。」。最後の 1 文（確認を頼む先）は、管理者でない利用者にだけ出す（画面が部品に渡す）。
  - 画面の側は、1 件の結果を部品に渡すときに、成功の札の下に 1 句を添えられる（もう保管にあった画像など）。
  - **失敗の知らせは「（理由は各行の状態）。」で止める**（2026-11-05。部品集の文の「失敗したファイルを選び直して、もう一度インポートしてください。」を外した）。tsunagi の失敗の多くは、もう画像サーバーにある画像・検査を BFF が断ったもので、選び直しても入らない。次にすることは行の理由で分かる。部品集へ戻すのは別の PR。
  - 状態の理由の 1 句は、語の途中で折らない（`word-break: auto-phrase`。列の幅 200px は変えない）。

## 知らせ（`.notice`）・空の状態（`.empty`）・確認の窓（`dialog.dlg`）

```html
<div class="notice" data-k="ok" role="status"><svg class="ic">…</svg><div>試験 太郎（P000101）の 412 画像を TSUNAGI へ送信しました。</div></div>
<div class="empty"><b>条件に合う予約はありません。</b><span>条件を変えるか、「条件をクリア」を押してください。</span><button class="btn">条件をクリア</button></div>
<dialog class="dlg" aria-labelledby="t1"><h3 id="t1">予約 RE202610250001（試験 太郎）を取消にしますか？</h3><p>…</p><div class="ft"><button class="btn" autofocus>キャンセル</button><button class="btn btn-primary">取消にする</button></div></dialog>
```

- 知らせ：左 4px の状態の色（`ok`・`warn`・`err`・`info`）・印・文。画面の上の誤りだけ `role="alert"`、ほかは `role="status"`。結果の文には 患者（氏名と ID）・相手・枚数を入れる。`.error`・`.notice-error` は使わず、これに揃える。
- 空の状態：表の枠と見出しの行を残し、その下に `.empty`（1 行目 事実・2 行目 次の手・操作 1 つまで）。`.empty-box` と `.empty` を混ぜない。権限の無い頁は `.empty.denied`：「この画面は管理者のみ利用できます。」／「管理者に役割の変更を頼んでください。」／「検査一覧へ」。黙って別の頁へ移さない。
- 確認の窓：**標準の `dialog`**（`showModal()`）。題は「対象＋動詞」の疑問、本文は 何が・どうなる・戻せるか（ris-emulator は送る HL7 の種類も）。キャンセルを左・初期のフォーカス、実行を右。ris-emulator の照合・完了・取消・中止に入れる。
- 確認の使い分け：理由や再認証を書かせる確認は区画の中の欄（開いたらその欄へスクロールとフォーカス）。理由の要らない最後の 1 回は確認の窓。権限・役割の変更は必ず確認の窓。
