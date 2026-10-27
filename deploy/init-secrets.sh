#!/bin/sh
# deploy/compose.yaml の secret のファイルを、乱数で作る。あるファイルは書き換えない（何度流してもよい）。
#
#   deploy/init-secrets.sh [置き場]      # 既定は deploy/secrets
#
# 作るもの（値は画面にも記録にも出さない）：
#   session_secret.txt          tsunagi-dicom の SESSION_SECRET（64 字）
#   backend_password.txt        tsunagi-dicom が Orthanc を使うときのパスワード（利用者は tsunagi）
#   orthanc-users.json          Orthanc の RegisteredUsers（tsunagi と、上と同じパスワード）
#   initial_admin_password.txt  tsunagi-dicom の最初の管理者（admin）のパスワード。最初のログインで変える
#
# 置き場は、この台本で新しく作ったときだけ、作った利用者だけが開ける（0700）にする。もとからあるディレクトリの権限は
# 変えない。group か others に開いている（mode & 077 が 0 でない）ときは、何も作らずに止まる（承知のうえで続けるときだけ
# ALLOW_INSECURE_SECRETS_DIR=1 を付ける。警告を出して続ける）。外の置き場は専用のディレクトリを指す（~/.config そのものを指さない）。
# ファイルは、コンテナの中の root でない利用者（tsunagi-dicom は uid 1000）が読めるように 0644 にする。
set -eu

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
dir=${1:-"$here/secrets"}

umask 077
if [ -d "$dir" ]; then
  mode=$(stat -c %a "$dir" 2> /dev/null || stat -f %Lp "$dir")
  # group か others に、読み・書き・実行のどれかを許していれば止める（0 から始めて 8 進数として数える）
  if [ $((0$mode & 077)) -ne 0 ]; then
    if [ "${ALLOW_INSECURE_SECRETS_DIR:-}" = 1 ]; then
      echo "警告：置き場 $dir の権限（$mode）が group か others に開いている。ALLOW_INSECURE_SECRETS_DIR=1 なので続ける（権限は変えない）" >&2
    else
      echo "置き場 $dir の権限（$mode）が group か others に開いている。secret を置かずに止める。専用のディレクトリを指すか、権限を締める（chmod 0700）。承知のうえで続けるときだけ ALLOW_INSECURE_SECRETS_DIR=1 を付ける" >&2
      exit 1
    fi
  fi
else
  mkdir -p "$dir"
  chmod 0700 "$dir"
fi

# 英数字だけの乱数（JSON とファイルにそのまま書ける字）
rand() {
  LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1"
}

# ファイルがあるか（壊れた symlink もあると見なし、その先に書かない）
exists() {
  [ -e "$1" ] || [ -L "$1" ]
}

# ファイルが無ければ、値を書いて 0644 にする
put() {
  if exists "$dir/$1"; then
    echo "そのまま：$dir/$1"
    return 0
  fi
  printf '%s\n' "$2" > "$dir/$1"
  chmod 0644 "$dir/$1"
  echo "作った：$dir/$1"
}

put session_secret.txt "$(rand 64)"
# 英字と数字を必ず含める（tsunagi-dicom のパスワードの規則）
put initial_admin_password.txt "Init$(rand 24)7"

# Orthanc のパスワードは2つのファイルにそろえて書く。片方だけあるときは止める（そろっているか分からないため）
if exists "$dir/backend_password.txt" && exists "$dir/orthanc-users.json"; then
  echo "そのまま：$dir/backend_password.txt・$dir/orthanc-users.json"
elif exists "$dir/backend_password.txt" || exists "$dir/orthanc-users.json"; then
  echo "backend_password.txt と orthanc-users.json の片方だけがある。2つの中のパスワードをそろえてから流し直す" >&2
  exit 1
else
  password=$(rand 32)
  put backend_password.txt "$password"
  put orthanc-users.json "{\"RegisteredUsers\": {\"tsunagi\": \"$password\"}}"
fi
