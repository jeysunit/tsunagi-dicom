# 開発の一式だけの、Orthanc のビューアへの読み取り専用の入口（GET と HEAD だけを通す）。root でない利用者で動かす。
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE}
WORKDIR /app
COPY docker/dev/viewer-proxy/*.ts ./
USER node
EXPOSE 8080
CMD ["node", "main.ts"]
