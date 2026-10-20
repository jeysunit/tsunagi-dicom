#!/bin/sh
# 結合の試験：/dumps/<組> の DICOM の dump（文字の形。試験が架空の患者で書いたもの）を dump2dcm で DICOM のファイルにし、
# storescu で送る。作ったファイルはコンテナの中（/tmp）にだけ置く（手元のフォルダに書かない）。
#   send-dumps <組> <送る側の AE タイトル> <送り先の AE タイトル> <送り先> <ポート>
set -eu

if [ "$#" -ne 5 ]; then
  echo "使い方: send-dumps <組> <送る側の AE タイトル> <送り先の AE タイトル> <送り先> <ポート>" >&2
  exit 2
fi
batch="$1"
calling="$2"
called="$3"
host="$4"
port="$5"

case "$batch" in
  *[!A-Za-z0-9_-]*|"") echo "組の名前の形が誤り: $batch" >&2; exit 2 ;;
esac
src="/dumps/$batch"
[ -d "$src" ] || { echo "組が無い: $src" >&2; exit 2; }

out="$(mktemp -d)"
count=0
for dump in "$src"/*.dump; do
  [ -f "$dump" ] || continue
  name="$(basename "$dump" .dump)"
  # +te：Explicit VR Little Endian で書く（ファイルの頭の meta 情報も付ける）
  dump2dcm --write-xfer-little "$dump" "$out/$name.dcm"
  count=$((count + 1))
done
[ "$count" -gt 0 ] || { echo "dump が無い: $src" >&2; exit 2; }

storescu --aetitle "$calling" --call "$called" --scan-directories "$host" "$port" "$out"
echo "send-dumps: $count 件を $called へ送った"
