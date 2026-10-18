#!/bin/sh
# BFF のデータベース（/data）の migration を流してから、サーバーを起動する。
# 設定の確かめ（足りない・誤った値で止める）はサーバーの起動の時に行う（src/lib/startup.ts）。
set -eu

cd /opt/prisma-cli
node node_modules/prisma/build/index.js migrate deploy

cd /app
exec node server.js
