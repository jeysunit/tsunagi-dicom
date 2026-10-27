# up.sh と refresh.sh が読み込む共通の決まり（単独では流さない）。
#
# secrets の置き場：TSUNAGI_DEV_SECRETS_DIR で替えられる（既定は docker/dev/secrets）。
# 作業ツリーの外の専用のディレクトリ（例 ~/.config/tsunagi-dev/secrets。~/.config そのものは指さない）に置くと、
# 作業ツリーを消してもパスワードが消えない。~ で始まる値は $HOME に展開する。相対のパスは、流した場所から数える。

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH='' cd -- "$here/../.." && pwd)

secrets=${TSUNAGI_DEV_SECRETS_DIR:-$here/secrets}
case $secrets in
  "~") secrets=${HOME:-} ;;
  "~/"*) secrets="${HOME:-}/${secrets#"~/"}" ;;
esac
case $secrets in
  /*) ;;
  *) secrets="$PWD/$secrets" ;;
esac
# $HOME・$HOME/.config・/ そのものは置き場にしない（秘密のファイルを広い場所に撒かない。専用のディレクトリを指す）。
# 書いたままの値と、実体（シンボリックリンクを辿った値）の両方を、末尾のスラッシュを除いて照らす
secrets_home=${HOME:-}
secrets_real=$(CDPATH='' cd -P -- "$secrets" 2> /dev/null && pwd) || secrets_real=$secrets
secrets_home_real=$(CDPATH='' cd -P -- "$secrets_home" 2> /dev/null && pwd) || secrets_home_real=$secrets_home
for candidate in "$secrets" "$secrets_real"; do
  while [ "${candidate%/}" != "$candidate" ]; do candidate=${candidate%/}; done
  [ -n "$candidate" ] || candidate=/
  for broad in / "$secrets_home" "$secrets_home/.config" "$secrets_home_real" "$secrets_home_real/.config"; do
    if [ -z "$secrets_home" ] && [ "$broad" != / ]; then continue; fi
    if [ "$candidate" = "$broad" ]; then
      echo "secrets の置き場（$secrets）が広すぎる（\$HOME・\$HOME/.config・/ そのものは使えない）。専用のディレクトリ（例 ~/.config/tsunagi-dev/secrets）を指す" >&2
      exit 1
    fi
  done
done
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
