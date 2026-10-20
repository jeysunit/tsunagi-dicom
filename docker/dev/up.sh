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
# ポートは環境変数で替えられる：TSUNAGI_HTTP_PORT（既定 3000）・ORTHANC_DICOM_PORT（既定 4242）・DEV_TDG_WEB_PORT（既定 18080）
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
# 壊れた symlink もあると見なし、その先に書かない
if [ ! -e "$secrets/tdg_web_password.txt" ] && [ ! -L "$secrets/tdg_web_password.txt" ]; then
  (
    umask 077
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24 > "$secrets/tdg_web_password.txt"
    printf '\n' >> "$secrets/tdg_web_password.txt"
  )
  # dicom-test-generator のコンテナの中の利用者（uid 10001）が読めるようにする（置き場は 0700）
  chmod 0644 "$secrets/tdg_web_password.txt"
  echo "作った：$secrets/tdg_web_password.txt"
fi

# 2. tsunagi-dicom のイメージ
if [ -z "${TSUNAGI_IMAGE:-}" ]; then
  TSUNAGI_IMAGE=tsunagi-dicom:dev
  export TSUNAGI_IMAGE
  echo "tsunagi-dicom のイメージを作る（$TSUNAGI_IMAGE）"
  docker build -t "$TSUNAGI_IMAGE" "$root"
fi

# 3. 立てる（dicom-test-generator と storescp のイメージも作る）。起きるまで待つ
docker compose -f "$here/compose.yaml" up -d --build --wait --wait-timeout 600

# 4. 開く先
cat <<EOF

起動した。架空の患者だけで使う。
  tsunagi-dicom           http://127.0.0.1:${TSUNAGI_HTTP_PORT:-3000}/
                          最初の管理者は admin。パスワードは $secrets/initial_admin_password.txt
                          （最初のログインで、自分のパスワード（13 文字以上・英字と数字）に変える）
  dicom-test-generator    http://127.0.0.1:${DEV_TDG_WEB_PORT:-18080}/
                          利用者は dtg。パスワードは $secrets/tdg_web_password.txt
  Orthanc の DICOM        127.0.0.1:${ORTHANC_DICOM_PORT:-4242}（AE タイトル ORTHANC）。REST はホストに出していない

架空の患者を CLI で送る：
  docker compose -f $here/compose.yaml exec tdg python -m app.cli exam --emergency --patient-id DEV0001 --patient-name "DEV^TARO" -s 1 -i 3 --send
storescp（送信先 dev-scp）に届いたファイル：
  docker compose -f $here/compose.yaml exec storescp find /received -type f
止める：
  docker compose -f $here/compose.yaml down
EOF
