# 画面のデザインシステム

tsunagi-dicom・ris-emulator・dicom-test-generator の画面を、同じ外枠で作るための部品と並びの決まり。

## 最上位の目的

その画面の目的の判断に要る情報と操作だけを、迷わず実行できる位置に置く。

次の原則はこの目的を画面の作りに落とした決まり。決まり同士がぶつかったら、この 1 文で決める。

## 原則

1. **色は状態にだけ使う。** 藍は選択・主な操作・リンクだけで、正常や異常の意味を持たせない。状態は赤・黄・緑と灰で示す。
2. **面の区別は地の濃淡で付ける。** 白・F6・EE・E2 の 4 段。線は細く、影は確認の窓のように浮くものにだけ付ける。
3. **要約から詳細へ。** 件数と状態を上に、明細を下に置く。一覧の上に件数、選んだ行の下に詳細。
4. **患者バナーはどの画面でも同じ位置・同じ並び。** 氏名（かな）・患者ID・生年月日と性別・受付番号・検査日時・モダリティと検査名の順。患者のある画面は必ず見出しの下に置く。
5. **主な操作は 1 画面に 1 つ。** 見出しの行の右端か、入力の画面の操作の行の右端に置く。一覧の右に開く詳細は、Study UID の下の操作の行に置く（menu.md）。危険な操作は間をあけ、確認の窓を挟む。
6. **色だけで伝えない。** 状態の札は文字と形の印（○ ◐ ● — ■ ✓ ✕ ？）を必ず持つ。誤りは文字と印で示す。
7. **画面の文言は現場の言葉で短く。** 説明の文を置かない。誤り・知らせ・窓の文は、「何が起きたか」「なぜか」「次にすること」を、対象の名前を入れて、この順で書く（狭い場所では「なぜか」と「次にすること」を残す）。何が合わないかを書き、「正しくありません」「無効」とは書かない。入力欄の下の誤りは読み上げず、画面の上の知らせだけを読み上げる。空は事実と次の手の 2 行（components.md の「空の状態」）。詳しくは [writing.md](writing.md)。

## 決まっていること

- **画面への入り口は左のナビに置く。** 上の帯のタブは使わない（[menu.md](menu.md)）。項目の名前は用語集の語（検査一覧・受信一覧・接続先など）。
- **詳細の見出しは患者バナーに替える。** 紹介医・英字氏名・Study ID・シリーズ数と画像数はバナーに足さず、「検査の情報」に置く（和暦は生年月日の括弧の中）。
- **モダリティ MR の印の色は `#9333EA`（暗い地は `#C084FC`）。**
- **暗い外枠は使わない。** 上の帯・左のナビは `surface` の地にする。

## 画面を触る前に

画面（`src/app`・`src/components`）を作る・直す前に、この文書を読む。

- **型に無い部品は、まずこの文書と部品の実装に足す PR を出してから使う。** 画面の PR の中で、この文書に無い見た目の部品や値を作らない。
- 色は `src/app/globals.css` のトークン（`--color-*`）で指定する。`#hex`・`rgb()`・Tailwind の色名（`bg-red-500`・`text-white` など）は書かない。足りない色は、先にトークンを足す PR を出す。検査は `tests/unit/design-system.test.ts`。例外は同じファイルの一覧に理由つきで載せる。
- 値を変えるときは、`tokens.md`・`globals.css`・`docs/spec.md` の 2 を同じ PR で直す。表と `globals.css` の食い違いは `tests/unit/design-system.test.ts` が落とす。

## 文書

| ファイル | 中身 |
|---|---|
| [tokens.md](tokens.md) | 色・文字・余白・角・影・枠線 |
| [components.md](components.md) | 部品。使う場面・挙動と数値・使わない場面・NG と代わり・理由 |
| [screen-types.md](screen-types.md) | 画面の 7 つの型と確認表 |
| [menu.md](menu.md) | 上の帯・左のナビ・見出しの行のメニューの決まり |
| [glossary.md](glossary.md) | 画面の言葉の決まり。語の使い分けと、3 製品をまたいだ語の対照 |
| [parts.md](parts.md) | 部品の HTML の構造・クラス・値。`src/components/ui` に同じ構造とクラスの名前で組む |
| [writing.md](writing.md) | 文言（誤り・知らせ・空の状態・確認の窓）の書き方 |
| [ui-kit/](ui-kit/) | 3 製品で同じ値の写し（`tokens.css`・`icons.svg`、版は `VERSION`、指紋は `SHA256SUMS`）。`components.css` は読まないので写さない |
| [scenarios.md](scenarios.md) | 検証のシナリオ。同じ 1 件の検査を 8 画面に通す |
| [wireframes/](wireframes/) | 部品だけで組んだ画面の案（HTML。ブラウザで開く。データは架空） |

ui-kit の写しは製品の側で直さない。`globals.css` の値はこの写しと同じにし、写した 3 つの指紋が `SHA256SUMS` と合うことと合わせて、試験で確かめる（`tests/unit/design-system.test.ts`・`tests/unit/ui-kit-copy.test.ts`）。絵は `icons.svg` の表にあるものを、`lucide-react` の同じ名前でそのまま使う。

## 部品の実装の場所

| 部品 | 実装 | 状態 |
|---|---|---|
| 上の帯 | `src/components/layout/site-header.tsx`（接続の状態は `conn-status.tsx`、表示は `theme-toggle.tsx`） | あり。左は ナビの開閉・製品名・版、右は 接続の状態・表示（絵の押しボタン 1 つ）・利用者（2 行）・画面ロック・ログアウト。項目の置き方は [menu.md](menu.md) の「現状との差」 |
| 左のナビ | `src/components/layout/side-nav.tsx`（項目は `nav-items.ts`、開閉は `nav-toggle.tsx`） | あり |
| 患者バナー | `src/components/ui/patient-banner.tsx` | あり。検査の詳細の見出し（`study-detail.tsx`）が使う。紹介医などは、見出しの下の「検査の情報」（項目名と値の対）へ置いた |
| タブ | `src/components/ui/tabs.tsx` | 部品はある。使う画面は今は無い（検査の詳細は、「検査の情報」をタブに隠さず並べるようにした） |
| 検索の帯 | `src/components/studies/study-browser.tsx` の `FilterBar` | あり |
| 件数の行 | `src/components/ui/count-row.tsx` | あり。検査の一覧が使う |
| 一覧の表 | `src/components/ui/table.tsx` | あり。選んだ行の見た目は検査一覧（`study-browser.tsx`）と受信一覧（`received-list.tsx`）が同じ形で持つ |
| タグの表 | `src/components/studies/tag-grid.tsx` | あり。行の複数選択と「タグとタグ値をコピー」（計算は `src/lib/client/row-selection.ts`・`tag-copy.ts`） |
| 状態の札 | `src/components/ui/status-badge.tsx` | あり。上の帯の接続の状態（`conn-status.tsx`）が使う。表の状態の列は、その列を足す PR から |
| 選択欄 | `src/components/ui/select.tsx` | あり。高さは `default` 32px・`sm` 28px、枠は `border-input`。標準の select をそのまま使う |
| 知らせ | `src/components/ui/notice.tsx` | あり。`kind` は ok・warn・err・info。`role="alert"` は `alert` を付けた err（画面の上の誤り）だけで、ほかは `role="status"` |
| 見出しの行 | `src/components/ui/page-header.tsx` | あり。h1（20px・行 28px・太字）に頁の名前だけ。補足は `note`（small）、右に `actions` |
| 空の状態 | `src/components/ui/empty-state.tsx` | あり。事実・次の手・操作 1 つ。`kind="denied"` は権限の無い頁の型（黙って別の頁へ移さない） |
| ボタン | `src/components/ui/button.tsx` | あり |
| 確認の窓 | `src/components/ui/confirm-dialog.tsx` | あり。標準の `dialog`（showModal）を使う。いまはロックの画面のログアウトと、ユーザー管理（役割の変更・無効にする・二要素認証のリセット）が使う |
| 入力欄 | `src/components/ui/input.tsx` | あり |
| 待ちの印 | `src/components/ui/pending.tsx` | あり |
