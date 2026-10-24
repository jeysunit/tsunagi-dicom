#!/bin/sh
# 開発・試験用の一式（docker/dev/compose.yaml）を立てる：
#   1. secret のファイルを乱数で作る（docker/dev/secrets/。リポジトリに入れない。あるファイルは書き換えない）
#   2. tsunagi-dicom のイメージを、このリポジトリから作る（TSUNAGI_IMAGE を渡せば作らずにそれを使う）
#   3. 一式を立て、起きるのを待つ
#   4. 開く URL と、最初の管理者のパスワードの在りかを出す（パスワードそのものは出さない）
#
#   docker/dev/up.sh
#   TSUNAGI_IMAGE=ghcr.io/jeysunit/tsunagi-dicom:sha-xxxxxxx docker/dev/up.sh   # GHCR のイメージを使うとき
#
# ポートは環境変数で替えられる：TSUNAGI_HTTP_PORT（既定 3000）・ORTHANC_DICOM_PORT（既定 4242）・DEV_DTG_WEB_PORT（既定 18080）・
# DEV_RIS_WEB_PORT（既定 18081）
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH='' cd -- "$here/../.." && pwd)
secrets="$here/secrets"

if ! docker compose version > /dev/null 2>&1; then
  echo "docker compose（v2）が使えない。Docker を入れてから流す" >&2
  exit 1
fi

# 1. secret のファイル（tsunagi-dicom と Orthanc の分は配る compose と同じ作り方）
"$root/deploy/init-secrets.sh" "$secrets"
# Web 画面のパスワード（dicom-test-generator と ris-emulator）と、HL7 の受け口と tsunagi-dicom の間の token。
# 2 つめの引数は字の数（既定 24）。壊れた symlink もあると見なし、その先に書かない
web_password() {
  file="$secrets/$1"
  length=${2:-24}
  if [ ! -e "$file" ] && [ ! -L "$file" ]; then
    (
      umask 077
      LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$length" > "$file"
      printf '\n' >> "$file"
    )
    # コンテナの中の利用者（DTG・ris-emulator は uid 10001、tsunagi-dicom と受け口は uid 1000）が読めるようにする（置き場は 0700）
    chmod 0644 "$file"
    echo "作った：$file"
  fi
}
web_password dtg_web_password.txt
web_password ris_web_password.txt
# 英数字 48 字（約 285 bit。乱数 32 バイトより多い）
web_password hl7_receiver_token.txt 48

# 2. tsunagi-dicom のイメージ。名前に compose のプロジェクトの名前を入れ、一式ごとに分ける（compose.yaml の ris・dtg・storescp と同じ）。
#    プロジェクトの名前は compose が決めたもの（環境変数・.env・compose.yaml の name）を、dtg のイメージの名前から取る
project=$(docker compose -f "$here/compose.yaml" config --images | sed -n 's/-dtg:local$//p')
if [ -z "$project" ]; then
  echo "compose のプロジェクトの名前を決められない（docker compose -f $here/compose.yaml config --images を見る）" >&2
  exit 1
fi
COMPOSE_PROJECT_NAME=$project
export COMPOSE_PROJECT_NAME
if [ -z "${TSUNAGI_IMAGE:-}" ]; then
  TSUNAGI_IMAGE="$project-tsunagi:local"
  export TSUNAGI_IMAGE
  echo "tsunagi-dicom のイメージを作る（$TSUNAGI_IMAGE）"
  docker build -t "$TSUNAGI_IMAGE" "$root"
fi

# 3. 立てる（ris-emulator・dicom-test-generator・storescp のイメージも作る）。起きるまで待つ。
#    compose に無くなったサービスのコンテナ（2026-10-21 に dtg へ名前を替える前の tdg など）は消す（ボリュームは消さない）
docker compose -f "$here/compose.yaml" up -d --build --wait --wait-timeout 600 --remove-orphans

# 4. 開く先
cat <<EOF

起動した。架空の患者だけで使う。
  tsunagi-dicom           http://127.0.0.1:${TSUNAGI_HTTP_PORT:-3000}/
                          最初の管理者は admin。パスワードは $secrets/initial_admin_password.txt
                          （最初のログインで、自分のパスワード（13 文字以上・英字と数字）に変える）
  dicom-test-generator    http://127.0.0.1:${DEV_DTG_WEB_PORT:-18080}/
                          利用者は dtg。パスワードは $secrets/dtg_web_password.txt
  ris-emulator            http://127.0.0.1:${DEV_RIS_WEB_PORT:-18081}/
                          利用者は ris。パスワードは $secrets/ris_web_password.txt
                          MWL は AE タイトル RIS_EMU（コンテナ ris の 11112。ホストには出していない）
  Orthanc の DICOM        127.0.0.1:${ORTHANC_DICOM_PORT:-4242}（AE タイトル ORTHANC）。REST はホストに出していない

ris-emulator で今日の CT の予約を 3 件作る（dicom-test-generator のワークリストに出る）：
  docker compose -f $here/compose.yaml exec ris python -m app.cli create CT=3
予約で撮って送る（KEY はワークリストの一覧の KEY の列）：
  docker compose -f $here/compose.yaml exec dtg python -m app.cli worklist query
  docker compose -f $here/compose.yaml exec dtg python -m app.cli exam --from-worklist KEY -s 1 -i 3 --send
架空の患者を、予約なし（緊急の患者）で送る：
  docker compose -f $here/compose.yaml exec dtg python -m app.cli exam --emergency --patient-id DEV0001 --patient-name "DEV^TARO" -s 1 -i 3 --send
緊急の患者の検査を、ris-emulator から HL7 で正式な患者に統合する（受け口 hl7-receiver を通って Orthanc が書き換わる）：
  docker compose -f $here/compose.yaml exec ris python -m app.cli pir send --host hl7-receiver --kind a40 --patient-id P000001 --prior-patient-id DEV0001 --name "TANAKA^HIROSHI"
storescp（送信先 dev-scp）に届いたファイル：
  docker compose -f $here/compose.yaml exec storescp find /received -type f
止める：
  docker compose -f $here/compose.yaml down
EOF
