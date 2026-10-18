# tsunagi-dicom（つなぎだいこむ）

[English](README.en.md)

DICOMweb に対応した画像サーバー（Orthanc など）を**改造せずにバックエンドとして使い**、日本の医療機関の画像の見方に合わせた検査の一覧・患者ごとの時系列・ビューアの選び分けを提供する、独立した Web の画面と BFF（Backend For Frontend）。

> **Not for Diagnostic Use / 非医療機器。**
> 研究・教育・検証のためのソフトウェアで、医療機器としての承認・認証を受けていない。

## 状態

**段 1a まで（2026-10-18）。** 土台・BFF（検索の画面の API と、ビューアが画像を取る WADO-RS の読み取りだけの中継）・監査の記録・開発用の認証（`AUTH_MODE=dev`）・共通の画面・CI とイメージがある。
画面は、BFF を通した検査の件数と素の一覧の1頁だけ。アプリの利用者のログイン（`AUTH_MODE=local`）は段 1b で、それまでは `AUTH_MODE=dev` でしか起動せず、`AUTH_MODE=dev` はモックのバックエンド（`BACKEND_MOCK=true`）のときだけ起動する。つまり段 1a では、実の画像サーバーにはつながない。
実装は段ごとの PR で進める（[`docs/spec.md`](docs/spec.md) の「6. 段階」）。

画面は、最初は日本語だけ。文書は日本語を主にし、README は日本語と英語。

## 何をするか

- **検査の一覧**：検査日・モダリティ・状態（未検像・検像済・未読・既読・緊急・ブックマーク）ですぐ絞れる。氏名は漢字とかなに分けて出し、生年月日は和暦と年齢で出す。
- **ビューアの選び分け**：OHIF Viewer・Stone Web Viewer・VolView など、設定で与えたビューアから選んで開く。検査ごと・モダリティごとに既定を覚える。
- **患者ごとの時系列**と、2つの検査の比較。
- **簡易レポート**と文書（PDF など）の取り込み。
- **安全と運用の管理**：役割、二要素の認証、監査の記録など。厚生労働省のガイドライン（第7.0版 システム運用編）の項目との対応を [`docs/guideline-mapping.md`](docs/guideline-mapping.md) に示す。**ガイドラインへの適合は、運用を含めて各施設が判断するもので、このソフトウェアだけで「準拠」とはならない。**

**使い方の例**：病院・研究室の画像サーバーの前に置く日常の閲覧の画面として。臨床研究の画像の集め先（研究用の画像サーバー）の前に置き、読む人に元の患者の情報を見せない画面として（ブラインド読影の役割。段 4 の後の候補）。

画像サーバーとビューアのソースには手を入れない。つなぎ先はすべて設定（環境変数）で決める。検索と取得は DICOMweb を先に使い、Orthanc にしか無い機能は「Orthanc のときだけ有効」な部品に分ける。

## 試しに動かす（モック）

画像サーバー無しで、合成の見本（`tests/fixtures/orthanc`）を返すモックのバックエンドと、開発用の認証（`AUTH_MODE=dev`、書き込みは止める）で動かす。

```sh
mkdir -p secrets && openssl rand -base64 48 > secrets/session_secret.txt   # SESSION_SECRET_FILE で渡す（secrets/ はリポジトリに入れない）
BACKEND_MOCK=true AUTH_MODE=dev docker compose up --build
# http://127.0.0.1:3000/ を開く
```

手元で開発するとき（Node は `.nvmrc` の版。npm 11 の `allowScripts` を `.npmrc` の `strict-allow-scripts` で効かせている）：

```sh
npm ci
cp .env.example .env   # BACKEND_MOCK="true"・AUTH_MODE="dev"・SESSION_SECRET（か SESSION_SECRET_FILE）を入れる
mkdir -p data && DATABASE_URL="file:./data/tsunagi.db" npm run db:migrate
DATABASE_URL="file:./data/tsunagi.db" npm run dev
```

試験：`npm run lint`・`npm run typecheck`・`npm test`（Vitest）・`npm run build && npm run test:e2e`（Playwright。モックに対して流す）。

配備では、GHCR のイメージ（`ghcr.io/jeysunit/tsunagi-dicom`）を版のタグ（`vX.Y.Z`）か digest で指定する（`compose.yaml` の `TSUNAGI_IMAGE`）。

## 決まりの在り処

| 文書 | 中身 |
|---|---|
| [`docs/spec.md`](docs/spec.md) | 仕様（原則・技術の構成・機能・段階・既知の制約） |
| [`docs/guideline-mapping.md`](docs/guideline-mapping.md) | 第7.0版 システム運用編の節ごとの対応表 |
| [`docs/patient-name-test-cases.md`](docs/patient-name-test-cases.md) | 氏名の形の試験の一覧（機械で読める写しは `tests/fixtures/patient-names.json`） |
| [`tests/fixtures/orthanc/`](tests/fixtures/orthanc/) | モックに使う、合成の患者の応答の見本と、その置き換えの規則 |
| [`AGENTS.md`](AGENTS.md) | 開発の決まり（人にも、コーディングの支援の道具にも同じ） |
| [`.env.example`](.env.example) | 設定の例 |

## ライセンス

[MIT](LICENSE)。画像サーバーとは REST・DICOMweb でやり取りするだけで、そのコードを取り込まない。

## 商標

DICOM® は、医療の情報のデジタルの通信に関する規格の出版物について、米国 National Electrical Manufacturers Association（NEMA）の登録商標。
そのほかの名前は、それぞれの持ち主の商標であることがある。
