# 画面のデザインシステム

tsunagi-dicom・ris-emulator・dicom-test-generator の画面を、同じ外枠で作るための部品と並びの決まり。

## 最上位の目的

その画面の目的の判断に要る情報と操作だけを、迷わず実行できる位置に置く。

次の原則はこの目的を画面の作りに落とした決まり。決まり同士がぶつかったら、この 1 文で決める。

## 原則

1. **色は状態にだけ使う。** 藍は選択・主な操作・リンクだけで、正常や異常の意味を持たせない。状態は赤・黄・緑と灰で示す。
2. **面の区別は地の濃淡で付ける。** 白・F6・EE・E2 の 4 段。線は細く、影は確認の窓のように浮くものにだけ付ける。
3. **要約から詳細へ。** 件数と状態を上に、明細を下に置く。一覧の上に件数、選んだ行の下に詳細。
4. **患者バナーはどの画面でも同じ位置・同じ並び。** 氏名（かな）・患者ID・生年月日と性別・受付番号・検査日時・モダリティと記述の順。患者のある画面は必ず見出しの下に置く。
5. **主な操作は 1 画面に 1 つ。** 見出しの行の右端か、入力の画面の操作の行の右端に置く。危険な操作は間をあけ、確認の窓を挟む。
6. **色だけで伝えない。** 状態の札は文字と形の印（○ ◐ ● — ■ ✓ ✕ ？）を必ず持つ。誤りは文字と印で示す。
7. **画面の文言は現場の言葉で短く。** 説明の文を置かない。誤りは「何が・どうする」を 1 行で書く。空は事実と次の手の 2 行（components.md の「空の状態」）。

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
| [screen-types.md](screen-types.md) | 画面の型 A〜D と確認表 |
| [menu.md](menu.md) | 上の帯・左のナビ・見出しの行のメニューの決まり |
| [glossary.md](glossary.md) | 画面の言葉の決まり。語の使い分けと、3 製品をまたいだ語の対照 |
| [scenarios.md](scenarios.md) | 検証のシナリオ。同じ 1 件の検査を 8 画面に通す |
| [wireframes/](wireframes/) | 部品だけで組んだ画面の案（HTML。ブラウザで開く。データは架空） |

## 部品の実装の場所

| 部品 | 実装 | 状態 |
|---|---|---|
| 上の帯 | `src/components/layout/site-header.tsx` | あり。項目の置き方は [menu.md](menu.md) の「現状との差」 |
| 左のナビ | — | 未実装（上の帯のタブで代用中。移すかは未決） |
| 患者バナー | `src/components/ui/patient-banner.tsx` | 部品はある。詳細の見出し（`study-detail.tsx`）は別の作りのまま。移すときは同じ PR で試験を移す |
| 検索の帯 | `src/components/studies/study-browser.tsx` の `FilterBar` | あり |
| 件数の行 | `src/components/ui/count-row.tsx` | あり。検査の一覧が使う |
| 一覧の表 | `src/components/ui/table.tsx` | あり |
| 状態の札 | `src/components/ui/status-badge.tsx` | 部品はある。使う画面は状態の列を足す PR から |
| ボタン | `src/components/ui/button.tsx` | あり |
| 確認の窓 | `src/components/ui/confirm-dialog.tsx` | あり。標準の `dialog`（showModal）を使う。いまはロックの画面のログアウトが使う |
| 入力欄 | `src/components/ui/input.tsx` | あり |
| 待ちの印 | `src/components/ui/pending.tsx` | あり |
