# syntax=docker/dockerfile:1
# tsunagi-dicom のイメージ（多段）。root でない利用者（node、uid 1000）で動かし、/data だけを書ける場所にする。

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# ── 依存（better-sqlite3 を作るための道具を含む） ──
FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# Prisma の CLI が外（checkpoint.prisma.io）へ版の確かめを送らないようにする
ENV CHECKPOINT_DISABLE=1
WORKDIR /app
# .npmrc：allowScripts に無い install のスクリプトで止める（strict-allow-scripts）
COPY package.json package-lock.json .npmrc prisma.config.ts ./
COPY prisma ./prisma
# strict-allow-scripts は npm 11 の後の版の設定。土台のイメージの npm の版を作りの記録に残す
RUN npm --version && npm ci

# ── 作る ──
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build
# コンテナの中で流すコマンド（管理者のパスワードを失くしたとき。docs/security-and-maintenance.md の 4）を1つのファイルにまとめる
RUN npm run build:cli

# ── 起動の時に migration を流す Prisma の CLI だけ ──
FROM ${NODE_IMAGE} AS prisma-cli
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV CHECKPOINT_DISABLE=1
WORKDIR /opt/prisma-cli
COPY docker/prisma-cli/package.json docker/prisma-cli/package-lock.json docker/prisma-cli/.npmrc ./
RUN npm ci --omit=dev
COPY prisma.config.ts ./
COPY prisma ./prisma

# ── 動かす ──
FROM ${NODE_IMAGE} AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data /audit-anchors \
  && chown node:node /data /audit-anchors
# CHECKPOINT_DISABLE：起動の時の prisma migrate deploy が、外へ版の確かめを送らないようにする
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/data/tsunagi.db \
    TZ=Asia/Tokyo
WORKDIR /app
# 「バージョン情報」の頁に出す版とビルドの commit（イメージを作る側が渡す）。
# 版は scripts/app-version.sh が git から作る（.git はこの文脈に入らないので、中では作れない）。
# 渡さなければ、版は 0.0.0+unknown、commit は行ごと出さない
ARG APP_VERSION=""
ARG BUILD_COMMIT=""
ENV APP_VERSION=${APP_VERSION} \
    BUILD_COMMIT=${BUILD_COMMIT}
# アプリのファイルは root のもののまま（node の利用者からは読むだけ）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# docker compose exec tsunagi node cli/reset-admin-password.mjs --user <ユーザーID>（画面・API からは使えない）
COPY --from=builder /app/dist/cli ./cli
# コマンドが読む better-sqlite3 は、standalone が Prisma のアダプターの下に持つもの。そこへ道をつなぎ、
# 道が切れたら（Next.js の出力の並びが変わったら）ここで作りが止まるように、動かして確かめる
RUN mkdir -p /app/cli/node_modules \
  && ln -s ../../node_modules/@prisma/adapter-better-sqlite3/node_modules/better-sqlite3 /app/cli/node_modules/better-sqlite3 \
  && node -e "require('module').createRequire('/app/cli/x.cjs')('better-sqlite3')" \
  && node /app/cli/reset-admin-password.mjs --help > /dev/null
COPY --from=prisma-cli /opt/prisma-cli /opt/prisma-cli
COPY docker/entrypoint.sh /usr/local/bin/tsunagi-entrypoint
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# PID 1 の扱いは docker run --init・compose の init: true に任せる
ENTRYPOINT ["/usr/local/bin/tsunagi-entrypoint"]
