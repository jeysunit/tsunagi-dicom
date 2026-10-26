#!/bin/sh
# 結合の試験：Orthanc へ C-FIND（検査の単位）を送り、答えの 3 つの項目を dcmdump の行で出す（XML にすると文字の集合を読み替えて出すので使わない）。
# 答えの文字の集合（SpecificCharacterSet）と氏名・検査名が、どの文字コードで返るかを測るため。作ったファイルはコンテナの中（/tmp）にだけ置く。
# 問い合わせの文字の集合を省くと、問い合わせに SpecificCharacterSet を空（全部に合う）で入れる。
#   find-study <送る側の AE タイトル> <送り先の AE タイトル> <送り先> <ポート> <患者 ID> [<問い合わせの文字の集合>]
set -eu

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
  echo "使い方: find-study <送る側の AE タイトル> <送り先の AE タイトル> <送り先> <ポート> <患者 ID> [<問い合わせの文字の集合>]" >&2
  exit 2
fi
calling="$1"
called="$2"
host="$3"
port="$4"
patient="$5"
charset="${6:-}"

case "$patient" in
  *[!A-Za-z0-9_-]*|"") echo "患者 ID の形が誤り: $patient" >&2; exit 2 ;;
esac
case "$charset" in
  *[!A-Za-z0-9_\ ]*) echo "文字の集合の形が誤り: $charset" >&2; exit 2 ;;
esac

if [ -n "$charset" ]; then
  charset_key="SpecificCharacterSet=$charset"
else
  charset_key="SpecificCharacterSet"
fi

out="$(mktemp -d)"
findscu --study --aetitle "$calling" --call "$called" --extract --output-directory "$out" \
  -k "QueryRetrieveLevel=STUDY" -k "PatientID=$patient" -k "PatientName" -k "StudyDescription" -k "$charset_key" \
  "$host" "$port" >/dev/null
dcmdump -q +P 0008,0005 +P 0010,0010 +P 0008,1030 "$out/rsp0001.dcm"
