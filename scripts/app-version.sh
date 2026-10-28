#!/bin/sh
# 画面「バージョン情報」の版を git から作り、標準出力に 1 行で出す。
#   タグ vX.Y.Z の上            -> X.Y.Z
#   タグより後                  -> X.Y.Z+<タグからの commit の数>.g<短い commit>
#   タグが 1 つも無い           -> 0.0.0+<commit の数>.g<短い commit>
#   git が無い・git の情報が無い -> 0.0.0+unknown
# 医療の 3 製品（tsunagi-dicom・ris-emulator・dicom-test-generator）で同じ内容を置く。
# 履歴の浅い checkout（タグが取れていない）では「タグが 1 つも無い」の形になるので、CI は fetch-depth: 0 で取る。
unknown="0.0.0+unknown"

if ! command -v git >/dev/null 2>&1 || ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "$unknown"
  exit 0
fi

if described=$(git describe --tags --long --match 'v[0-9]*.[0-9]*.[0-9]*' 2>/dev/null); then
  # 例：v0.2.0-37-g60970f9。形が合わないタグ（v1.2.3-rc1 など）は unknown にする
  parsed=$(printf '%s\n' "$described" | sed -n 's/^v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)-\([0-9][0-9]*\)-g\([0-9a-f][0-9a-f]*\)$/\1 \2 \3/p')
  if [ -z "$parsed" ]; then
    echo "$unknown"
    exit 0
  fi
  set -- $parsed
  if [ "$2" = "0" ]; then
    echo "$1"
  else
    echo "$1+$2.g$3"
  fi
  exit 0
fi

count=$(git rev-list --count HEAD 2>/dev/null) || count=""
short=$(git rev-parse --short HEAD 2>/dev/null) || short=""
if [ -z "$count" ] || [ -z "$short" ]; then
  echo "$unknown"
else
  echo "0.0.0+$count.g$short"
fi
