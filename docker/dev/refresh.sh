#!/bin/sh
# 開発・試験用の一式（docker/dev/compose.yaml）を、3つの製品の main に立て直す（毎晩の自動実行にも使える）：
#   1. tsunagi-dicom：このリポジトリの作業ツリーを origin/main に早送りする（main 以外の枝・detached HEAD にいるときは、
#      切り替えずに止める。毎晩の立て直しは main にいる専用の作業ツリーで流す。未コミットの変更があるときも何もせずに止める）
#   2. DTG・ris-emulator：main の commit を git ls-remote で決める（DTG_GIT_REF・RIS_GIT_REF に commit を渡してあれば、それを使う）
#   3. 3つのイメージを作る（ここで失敗したら、動いているコンテナには触れずに止める）
#   4. docker compose up -d --build で立て直す
#   5. 3つの版（commit）と結果を、標準出力の最後の 1 行に出す
#
#   docker/dev/refresh.sh
#
# volume と secrets は消さない（down -v・volume rm を使わない）。secrets の置き場は up.sh と同じ（TSUNAGI_DEV_SECRETS_DIR。
# 既定 docker/dev/secrets）。置き場に compose が読む secret のファイルが1つでも無いときは、作らずに止める（up.sh を先に流す）。
# TSUNAGI_IMAGE を渡したときは、tsunagi-dicom のイメージは作らずにそれを使う（作業ツリーの早送りもしない）。
# ポートの環境変数は up.sh と同じ。
#
# 流している最中にこのファイルが早送りで書き換わっても壊れないよう、全体を関数に入れて、読み切ってから流す。
set -eu

. "$(dirname -- "$0")/lib.sh"

DTG_REPO=https://github.com/jeysunit/dicom-test-generator.git
RIS_REPO=https://github.com/jeysunit/ris-emulator.git

tsunagi_ver=-
dtg_ver=-
ris_ver=-
stage=準備

# 終わりの 1 行（成功も失敗も）。標準出力に出す
report() {
  status=$?
  if [ "$status" -eq 0 ]; then
    result=成功
  elif [ "$stage" = 立て直し ]; then
    result="失敗（立て直しの途中で止まった。docker compose -p ${COMPOSE_PROJECT_NAME:-tsunagi-dev} ps で確かめる）"
  else
    result="失敗（段：$stage。動いているコンテナはそのまま）"
  fi
  echo "refresh: tsunagi-dicom=$tsunagi_ver dtg=$dtg_ver ris=$ris_ver 結果=$result"
}

# 参照（ブランチ名か commit）を commit に決める。引数：リポジトリの URL、環境変数で渡された参照（空なら main）
resolve_ref() {
  ref=${2:-main}
  case $ref in
    *[!0-9a-f]* | '')
      sha=$(git ls-remote "$1" "refs/heads/$ref" | cut -f1)
      if [ -z "$sha" ]; then
        echo "$1 の $ref の commit を決められない" >&2
        return 1
      fi
      echo "$sha"
      ;;
    *) echo "$ref" ;;
  esac
}

main() {
  if ! docker compose version > /dev/null 2>&1; then
    echo "docker compose（v2）が使えない" >&2
    return 1
  fi
  # compose の secrets が file: で読む全部のファイルを、コンテナに触れる前に確かめる（存在だけを見る。値は読まない）
  for f in session_secret.txt backend_password.txt initial_admin_password.txt orthanc-users.json dtg_web_password.txt ris_web_password.txt hl7_receiver_token.txt; do
    if [ ! -f "$secrets/$f" ]; then
      echo "secrets の置き場（$secrets）に $f が無い。先に docker/dev/up.sh を流す（置き場を替えているなら TSUNAGI_DEV_SECRETS_DIR を渡す）" >&2
      return 1
    fi
  done

  stage="枝の確かめ"
  if [ -z "${TSUNAGI_IMAGE:-}" ]; then
    # main 以外の枝・detached HEAD では切り替えず、触らずに止まる（作業中の枝を動かさないため）
    branch=$(git -C "$root" symbolic-ref --short -q HEAD || true)
    if [ "$branch" != main ]; then
      echo "main 以外の枝（${branch:-detached HEAD}）にいるので立て直さない。main に戻すか、専用の作業ツリーで流す" >&2
      return 1
    fi
    stage="tsunagi-dicom の取り込み"
    git -C "$root" fetch --quiet origin main
    # 未コミットの変更と、追跡していない新しいファイル（.gitignore の対象は除く）があれば止める。ビルドの入力に入るため
    if [ -n "$(git -C "$root" status --porcelain)" ]; then
      echo "作業ツリー（$root）に未コミットの変更か、追跡していないファイルがある。片付けてから流す" >&2
      return 1
    fi
    git -C "$root" merge --quiet --ff-only origin/main
    # ローカルの main が origin/main より進んでいると、merge は何もせずに通る。そのまま作ると main でない版を配るので止める
    if [ "$(git -C "$root" rev-parse HEAD)" != "$(git -C "$root" rev-parse origin/main)" ]; then
      echo "ローカルの main が origin/main と一致しない（先に進んだ commit がある）。origin/main に揃えてから流す" >&2
      return 1
    fi
    tsunagi_ver=$(git -C "$root" rev-parse --short=7 HEAD)
  else
    tsunagi_ver=$TSUNAGI_IMAGE
  fi

  stage="DTG・ris-emulator の commit の決定"
  DTG_GIT_REF=$(resolve_ref "$DTG_REPO" "${DTG_GIT_REF:-}")
  RIS_GIT_REF=$(resolve_ref "$RIS_REPO" "${RIS_GIT_REF:-}")
  export DTG_GIT_REF RIS_GIT_REF
  dtg_ver=$(echo "$DTG_GIT_REF" | cut -c1-7)
  ris_ver=$(echo "$RIS_GIT_REF" | cut -c1-7)

  dev_project
  if [ -z "${TSUNAGI_IMAGE:-}" ]; then
    TSUNAGI_IMAGE="$COMPOSE_PROJECT_NAME-tsunagi:local"
    export TSUNAGI_IMAGE
  fi

  # 先に作るだけにする。ここで失敗しても、動いているコンテナは止まらない
  stage=イメージの作成
  if [ "$TSUNAGI_IMAGE" = "$COMPOSE_PROJECT_NAME-tsunagi:local" ]; then
    docker build -t "$TSUNAGI_IMAGE" "$root"
  fi
  docker compose -f "$here/compose.yaml" -p "$COMPOSE_PROJECT_NAME" build

  stage=立て直し
  docker compose -f "$here/compose.yaml" -p "$COMPOSE_PROJECT_NAME" up -d --build --wait --wait-timeout 600 --remove-orphans
}

trap report EXIT
main; exit $?
