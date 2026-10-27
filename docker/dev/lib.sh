# up.sh と refresh.sh が読み込む共通の決まり（単独では流さない）。
#
# secrets の置き場：TSUNAGI_DEV_SECRETS_DIR で替えられる（既定は docker/dev/secrets）。
# 作業ツリーの外（例 ~/.config/tsunagi-dev/secrets）に置くと、作業ツリーを消してもパスワードが消えない。
# 相対のパスは、流した場所から数える。

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH='' cd -- "$here/../.." && pwd)

secrets=${TSUNAGI_DEV_SECRETS_DIR:-$here/secrets}
case $secrets in
  /*) ;;
  *) secrets="$PWD/$secrets" ;;
esac
# compose.yaml・hl7.override.yaml・deploy/compose.yaml の secrets の file: が、同じ置き場を指すようにする
TSUNAGI_DEV_SECRETS_DIR=$secrets
TSUNAGI_SECRETS_DIR=$secrets
export TSUNAGI_DEV_SECRETS_DIR TSUNAGI_SECRETS_DIR

# compose のプロジェクトの名前（環境変数・.env・compose.yaml の name で決まるもの）を、dtg のイメージの名前から取る。
# 決めたら COMPOSE_PROJECT_NAME に入れて export し、tsunagi-dicom のイメージの名前（TSUNAGI_IMAGE の既定）も決める
dev_project() {
  project=$(docker compose -f "$here/compose.yaml" config --images | sed -n 's/-dtg:local$//p')
  if [ -z "$project" ]; then
    echo "compose のプロジェクトの名前を決められない（docker compose -f $here/compose.yaml config --images を見る）" >&2
    return 1
  fi
  COMPOSE_PROJECT_NAME=$project
  export COMPOSE_PROJECT_NAME
}
