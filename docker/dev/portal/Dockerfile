# 開発の一式だけの、3つの画面への入口のページ（静的の1枚）。root でない利用者で動かす。
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}
WORKDIR /app
COPY docker/dev/portal/*.ts ./
# 色と字のトークンは、デザインシステムの写し（docs/design-system/ui-kit）をそのまま使う
COPY docs/design-system/ui-kit/tokens.css ./
USER node
EXPOSE 8080
CMD ["node", "main.ts"]
