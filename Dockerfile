# syntax=docker/dockerfile:1
# tsunagi-dicom のイメージ（多段）。root でない利用者（node、uid 1000）で動かし、/data だけを書ける場所にする。

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

# ── 依存（better-sqlite3 を作るための道具を含む） ──
FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

# ── 作る ──
FROM deps AS builder
ENV NEXT_TELEMETRY_DISABLED=1
COPY . .
RUN npm run build

# ── 起動の時に migration を流す Prisma の CLI だけ ──
FROM ${NODE_IMAGE} AS prisma-cli
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/prisma-cli
COPY docker/prisma-cli/package.json docker/prisma-cli/package-lock.json ./
RUN npm ci --omit=dev
COPY prisma.config.ts ./
COPY prisma ./prisma

# ── 動かす ──
FROM ${NODE_IMAGE} AS runner
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/data/tsunagi.db \
    TZ=Asia/Tokyo
WORKDIR /app
# アプリのファイルは root のもののまま（node の利用者からは読むだけ）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=prisma-cli /opt/prisma-cli /opt/prisma-cli
COPY docker/entrypoint.sh /usr/local/bin/tsunagi-entrypoint
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# PID 1 の扱いは docker run --init・compose の init: true に任せる
ENTRYPOINT ["/usr/local/bin/tsunagi-entrypoint"]
