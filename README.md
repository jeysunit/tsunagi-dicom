# tsunagi-dicom（つなぎだいこむ）

[English](README.en.md)

DICOMweb に対応した画像サーバー（Orthanc など）を**改造せずにバックエンドとして使い**、日本の医療機関の画像の見方に合わせた検査の一覧・患者ごとの時系列・ビューアの選び分けを提供する、独立した Web の画面と BFF（Backend For Frontend）。

> **Not for Diagnostic Use / 非医療機器。**
> 研究・教育・検証のためのソフトウェアで、医療機器としての承認・認証を受けていない。

## 状態

> **設計の段で、本番（診療の現場・実の患者のデータ）には使わない。** いまは仕様と土台を作っている途中。

**段 2 まで（2026-10-19）。** 段 2 で、検査の一覧（すぐ絞れる見出し・氏名の漢字とかな・和暦と年齢・1 件 1 行の一覧と件数つきの絞り込み・詳細のパネルとシリーズのサムネイル・検像や読影などの状態）、ビューアの選び分けと記憶（検査ごと・モダリティごと）、画面の API の役割ごとの許可の一覧、明るい地と暗い地の切り替えを足した。実の画像サーバー（Orthanc）での確かめは、段 2 の PR に残した項目がある。

段 1b まで（2026-10-18）：段 1a の土台・BFF（検索の画面の API と、ビューアが画像を取る WADO-RS の読み取りだけの中継）・監査の記録・開発用の認証（`AUTH_MODE=dev`）・共通の画面・CI とイメージに、アプリの利用者のログイン（`AUTH_MODE=local`）を足した：利用者と役割（管理者・医師・技師・閲覧）、パスワードの規則（argon2id のハッシュ）、二要素の認証（TOTP）、ログインの一時停止、画面のロック、利用者の棚卸しの画面、役割ごとにできる操作、中継の役割の確かめ。
`AUTH_MODE=local` は実の画像サーバーにもつなげる（実の画像サーバーでの確かめはまだ）。`AUTH_MODE=dev` はこれまでどおり、モックのバックエンド（`BACKEND_MOCK=true`）のときだけ起動する。
画面は、ログイン・検査の一覧と詳細のパネル・モダリティごとの既定のビューア（管理者）・利用者の管理・自分の設定。文字を読む画面は明るい地を既定にし、暗い地に切り替えられる（利用者ごとに覚える）。
実装は段ごとの PR で進める（[`docs/spec.md`](docs/spec.md) の「6. 段階」）。

画面は、最初は日本語だけ。文書は日本語を主にし、README は日本語と英語。

## 何をするか

- **検査の一覧**：検査日・モダリティ・状態（未検像・検像済・未読・既読・緊急・ブックマーク）ですぐ絞れる。氏名は漢字とかなに分けて出し、生年月日は和暦と年齢で出す。
- **ビューアの選び分け**：OHIF Viewer・Stone Web Viewer・VolView など、設定で与えたビューアから選んで開く。検査ごと・モダリティごとに既定を覚える。
- **患者ごとの時系列**と、2つの検査の比較。
- **簡易レポート**（段 3）。文書（PDF など）の取り込みと表示、他の施設のデータの取り込み・値の修正・分割・結合は、重いので後ろに回した（4 の後）。
- **安全と運用の管理**：役割、二要素の認証、監査の記録など（画像サーバーの監視と読み取りだけの切り替えは 4 の後）。厚生労働省のガイドライン（第7.0版 システム運用編）の項目との対応を [`docs/guideline-mapping.md`](docs/guideline-mapping.md) に示す。**ガイドラインへの適合は、運用を含めて各施設が判断するもので、このソフトウェアだけで「準拠」とはならない。**

**使い方の例**：病院・研究室の画像サーバーの前に置く日常の閲覧の画面として。臨床研究の画像の集め先（研究用の画像サーバー）の前に置き、読む人に元の患者の情報を見せない画面として（ブラインド読影の役割。段 2b で入れる予定）。

この道具は治験・研究・システムの試験のための道具で、**機能は足すより削る**。

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

アプリの利用者のログイン（`AUTH_MODE=local`）で試すとき：最初の管理者は、利用者が1人もいないときだけ、起動の時に秘密のファイルから作る（`compose.yaml` の `INITIAL_ADMIN_USERNAME`・`INITIAL_ADMIN_PASSWORD_FILE` の例）。最初のログインで TOTP（`MFA_REQUIRED=true` のとき）を登録し、パスワードを本人のものに変える。**管理者は2人以上置く**（管理者が1人だけで認証のアプリを失くすと、いまは戻す道が無い。`docs/security-and-maintenance.md` の 4）。cookie は `Secure` なので、手元（`127.0.0.1`・`localhost`）のほかでは TLS（リバースプロキシ）の後ろに置く。

```sh
printf '%s\n' '<最初のパスワード>' > secrets/initial_admin_password.txt   # 8 文字以上・英字と数字を両方含める
# compose.yaml の INITIAL_ADMIN_* と secrets の initial_admin_password の行を有効にしてから
BACKEND_MOCK=true AUTH_MODE=local docker compose up --build
```

試験：`npm run lint`・`npm run typecheck`・`npm test`（Vitest）・`npm run build && npm run test:e2e`（Playwright。モックに対して、`AUTH_MODE=dev` と `AUTH_MODE=local` のサーバーを起こして流す）。

## イメージ（GHCR）

配備では、GHCR のイメージ（`ghcr.io/jeysunit/tsunagi-dicom`）を版のタグ（`vX.Y.Z`）か digest で指定する（`compose.yaml` の `TSUNAGI_IMAGE`）。イメージは CI が通ってから出す（`.github/workflows/image.yml`）。

| タグ | いつ付くか |
|---|---|
| `vX.Y.Z` | 版のタグの push のときだけ。**作り直しでは付けず、片付けでは消さない。** 同じ版のタグがもう GHCR にあれば（実行のやり直しなど）、出さずに止める |
| `sha-<短い hash>` | `main` への merge・版のタグ・週の作り直し。同じ commit を作り直すと、新しいイメージへ移る |
| `rebuild-YYYYMMDD` | 週に1回（月曜 03:17 UTC）と手動の、`main` の作り直し（日付は UTC）。イメージの中で apt で入れる包みの更新を取り込む |

**署名の確かめ。** 出したイメージの digest には、GitHub Actions の OIDC による cosign の鍵の要らない署名が付いている。配備の前に、digest を調べて確かめる：

```sh
docker buildx imagetools inspect ghcr.io/jeysunit/tsunagi-dicom:vX.Y.Z   # 出てくる Digest を使う
cosign verify ghcr.io/jeysunit/tsunagi-dicom@sha256:<digest> \
  --certificate-identity-regexp '^https://github\.com/jeysunit/tsunagi-dicom/\.github/workflows/image\.yml@refs/(heads/main|tags/v[0-9]+\.[0-9]+\.[0-9]+.*)$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

版のタグのイメージだけを受け入れるなら、`--certificate-identity-regexp` の代わりに `--certificate-identity https://github.com/jeysunit/tsunagi-dicom/.github/workflows/image.yml@refs/tags/vX.Y.Z` で、その版の workflow が署名したことまで確かめる。

**古いイメージの片付け**（`.github/workflows/image-cleanup.yml`、週に1回、月曜 06:41 UTC）：

- 残す：版のタグ（`v*`）の付いたイメージは全部。ほかのタグ（`sha-*`・`rebuild-*`）の付いたイメージは新しい順に 10 個。出してから 2 日より新しいイメージは全部。
- 消す：上に当たらないタグ付きのイメージと、タグの無いイメージ（`sha-*` のタグが新しいイメージへ移った後の古いイメージなど）。
- 署名・SBOM・provenance・プラットフォーム別の子は、親のイメージと一緒に残し、一緒に消す。
- **いまは dry-run**（消さずに、消す候補を実行の記録に出すだけ）。記録を確かめてから dry-run を外す。
- digest で止めて配備するなら、版のタグの付いたイメージの digest を使う（ほかのイメージは、いずれ消える）。

## 決まりの在り処

| 文書 | 中身 |
|---|---|
| [`docs/spec.md`](docs/spec.md) | 仕様（原則・技術の構成・機能・段階・既知の制約） |
| [`docs/guideline-mapping.md`](docs/guideline-mapping.md) | 第7.0版 システム運用編の節ごとの対応表 |
| [`docs/security-and-maintenance.md`](docs/security-and-maintenance.md) | セキュリティと保守の方針（システム構成図・通信の一覧・秘密の置き場・記録・版と支える期間・使い終えるときの片付け） |
| [`SECURITY.md`](SECURITY.md) | 脆弱性の報告の窓口と支える版 |
| [`docs/patient-name-test-cases.md`](docs/patient-name-test-cases.md) | 氏名の形の試験の一覧（機械で読める写しは `tests/fixtures/patient-names.json`） |
| [`tests/fixtures/orthanc/`](tests/fixtures/orthanc/) | モックに使う、合成の患者の応答の見本と、その置き換えの規則 |
| [`AGENTS.md`](AGENTS.md) | 開発の決まり（人にも、コーディングの支援の道具にも同じ） |
| [`.env.example`](.env.example) | 設定の例 |

## ライセンス

[MIT](LICENSE)。画像サーバーとは REST・DICOMweb でやり取りするだけで、そのコードを取り込まない。

## 商標

DICOM® は、医療の情報のデジタルの通信に関する規格の出版物について、米国 National Electrical Manufacturers Association（NEMA）の登録商標。
そのほかの名前は、それぞれの持ち主の商標であることがある。
