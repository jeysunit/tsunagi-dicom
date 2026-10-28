# トークン

色と文字の値の正本は `src/app/globals.css`。この文書の表と食い違えば、試験（`tests/unit/design-tokens.test.ts`）が落ちる。値を変えるときは、この表・`globals.css`・`docs/spec.md` の 2 を同じ PR で直す。

## 1. 色

| 名前 | 役割 | 明るい地 | 暗い地 |
|---|---|---|---|
| `--color-background` | 画面の地・入力欄の地 | #FFFFFF | #1B1B1B |
| `--color-surface` | 上の帯・左のナビ・表の見出し・患者バナー・区画の見出し | #F6F6F6 | #242424 |
| `--color-muted` | 行にのせたときの地・境目 | #EEEEEE | #2D2D2D |
| `--color-muted-strong` | 検索の帯 | #E2E2E2 | #383838 |
| `--color-foreground` | 本文 | #262626 | #E8E8E8 |
| `--color-value` | 値（太字で出す） | #1A1A1A | #FFFFFF |
| `--color-label` | 項目名・補足・表の見出し | #5F5F5F | #A3A3A3 |
| `--color-border` | 区切りの線・区画の枠 | #D2D2D2 | #3A3A3A |
| `--color-border-input` | 入力欄・ボタンの輪郭 | #7A7A7A | #8A8A8A |
| `--color-primary` | 主ボタンの地・選択を示す線 | #4B4FBF | #4B4FBF |
| `--color-primary-foreground` | 主ボタンの文字 | #FFFFFF | #FFFFFF |
| `--color-primary-hover` | 主ボタンの hover | #3B3EA3 | #3B3EA3 |
| `--color-primary-active` | 主ボタンを押している間 | #2F3288 | #2F3288 |
| `--color-link` | リンクの文字 | #4B4FBF | #A5A8FF |
| `--color-ring` | フォーカスの輪 | #4B4FBF | #A5A8FF |
| `--color-selected` | 選択中のナビの地・選択の薄い地 | #EDEDF9 | #272844 |
| `--color-selected-strong` | 一覧の選んだ行の地 | #D9DAF3 | #383B73 |
| `--color-hover` | 押せる物の hover の地 | #E2E2E2 | #333333 |
| `--color-pressed` | 押している間の地 | #D2D2D2 | #3A3A3A |
| `--color-danger` | 失敗・中止・誤り・危険な操作 | #D1242F | #FF7B72 |
| `--color-danger-foreground` | 危険の色を地にしたボタンの文字 | #FFFFFF | #1B1B1B |
| `--color-success` | 完了・成功・確認済み | #1A7F37 | #3FB950 |
| `--color-warning` | 実施中・送信中・注意 | #9A6700 | #D29922 |
| `--color-dev-band` | 検証モードの帯の地 | #6B4A00 | #6B4A00 |
| `--color-dev-band-foreground` | 検証モードの帯の文字 | #FFE8A3 | #FFE8A3 |

モダリティの印は飾りで、名前の文字を必ず添える。

| 名前 | 対象 | 明るい地 | 暗い地 |
|---|---|---|---|
| `--color-mod-ct` | CT | #0969DA | #4493F8 |
| `--color-mod-mr` | MR | #9333EA | #C084FC |
| `--color-mod-crdx` | CR・DX | #1A7F37 | #3FB950 |
| `--color-mod-us` | US | #BC4C00 | #F0883E |
| `--color-mod-es` | ES | #BF3989 | #F778BA |
| `--color-mod-mg` | MG | #9A6700 | #D29922 |
| `--color-mod-doc` | DOC | #6E7781 | #9198A1 |
| `--color-mod-sr` | SR | #1B7C83 | #39C5CF |

## 2. 文字

字体は OS の標準（system-ui、Noto Sans JP）。商用の字体の名前を書かない。基準は 14px・行間 1.5。太さは 400 と 700 の 2 つだけ。

| 段 | 大きさ / 行間 | 太さ | 使う場所 |
|---|---|---|---|
| text-xs | 12px / 18px | 400 | 項目名・補足・表の見出し・札 |
| text（基準） | 14px / 21px | 400 | 本文・表のセル・入力欄 |
| value | 14px / 21px | 700 | 値・選んだ行・ナビの現在地 |
| text-lg | 16px / 24px | 700 | 患者バナーの氏名・区画の見出し・窓の題 |
| text-xl | 20px / 28px | 700 | 画面の題 |
| text-2xl | 24px / 32px | 700 | 要約の数だけ |
| mono | 13px / 20px | 400 | ID・AEタイトル |
| mono-uid | 12px / 18px | 400 | UID（長い値を、行の幅いっぱいに折り返して出す。色は `--color-label`） |

## 3. 余白・高さ

| 名前 | 値 | 使う場所 |
|---|---|---|
| s1 | 4px | 札の内側・アイコンとの間 |
| s2 | 8px | 部品の内側・ボタンの間 |
| s3 | 12px | 区画の内側・区画の間 |
| s4 | 16px | 上の帯・検索の帯の左右 |
| s5 | 24px | 画面の左右 |
| s6 | 32px | 空の状態の内側 |
| s7 | 48px | 上の帯の高さ |

| 部品 | 高さ・幅 | 決まり |
|---|---|---|
| 上の帯 | 48px | 全画面で同じ。固定 |
| 左のナビ | 幅 208px（閉じると 56px） | 項目の高さ 32px |
| ボタン・入力欄 | 32px（小は 28px、一覧の行内は 24px） | 押せる大きさの下限は 24px |
| 表の行 | 28px（サムネイルや 2 行の氏名があるときは 40px） | 見出しの行も 28px |
| 画面の中身 | 左右 24px・上 12px・区画の間 12px | 表は幅いっぱい、入力の画面は最大 900px |
| 本文の幅 | 一覧の型は幅いっぱい・詳細だけの画面 1200px・入力フォーム 900px・設定 560px・ログイン 384px | 型ごとに 1 つ。すべて左寄せ（ログインだけ中央）（[screen-types.md](screen-types.md) の「本文の幅と寄せ方」） |

この頁の値は [ui-kit/tokens.css](ui-kit/tokens.css)（ui-kit 1.0.0）と同じにする。部品の HTML の構造とクラスは [parts.md](parts.md)。字の大きさは「2. 文字」の表のとおりで、h1 は 3 製品とも 20px。

## 4. 角・影・枠線

| 項目 | 値 | 使う場所 |
|---|---|---|
| 角 sm | 4px | ボタン・入力欄・ナビの項目・札（3px） |
| 角 md | 6px | 区画・表・患者バナー・検索の帯 |
| 角 lg | 8px | 確認の窓・部品の外枠 |
| 影 | なし | 面は地の濃淡で分ける |
| 影 lg | 0 4px 16px（明るい地 16%・暗い地 60% の黒） | 確認の窓・浮くメニューだけ |
| 枠線 | 1px `--color-border` | 区画・表・バナー |
| 入力の枠 | 1px `--color-border-input` | 入力欄・ボタン・選択。白との対比 4.29:1、検索の帯（`muted-strong`）の上で 3.31:1（暗い地は `#383838` の上で 3.40:1）。前の #8C8C8C・#777777 は帯の上で 2.6:1 だった（2026-10-26） |
| 選択の印 | 左に 3px の `--color-primary`（内側の線） | 選んだ行・選んだナビの項目 |
| 知らせの印 | 左に 4px（状態の色） | 知らせ |
| フォーカス | 2px の輪（`--color-ring`）、間隔 2px | 操作できるすべての部品 |

## 5. 値の決まり

- **グレーは色味のない中立にする。** 面の濃淡（background・surface・muted・muted-strong）で区別し、線は細くする。
- **アクセントは藍（primary）。** 選択・主な操作・リンクだけに使い、正常や異常の意味を持たせない。状態は danger・success・warning と灰で示す。
- **文字と地の対比は 4.5:1 以上。** 文字の色と地の組を全部、試験で確かめる。
- **入力欄の輪郭（border-input）は、区切りの線（border）より濃くする。** 地との対比 3:1 以上。
- **warning は「実施中」「送信中」を出すための色。** 赤でも緑でもない状態に使い、文字と印（◐・◔）を必ず添える。
- **モダリティの印の色は飾り。** 意味は名前の文字が持つ。MR は赤紫（#9333EA）にして、青い CT との色の差を大きく取る（#8250DF は CT との差が小さかった）。
- **暗い外枠は使わない。** 上の帯・左のナビは `surface` の地にする。原則 1・2 の例外を増やさないため、外枠用のトークンは持たない。
