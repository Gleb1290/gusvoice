# DeepFilterNet3 noise-filter assets (wasm + onnx model) for the in-app "DeepFilter" option.
# Fetched once at image-build time and served same-origin under /noise/, so neither the web
# client nor the desktop app depends on an external CDN at runtime. These are the Apache/MIT
# DeepFilterNet3 weights mirrored by mezon.ai; the `deepfilternet3-noise-filter` npm glue
# appends v2/pkg/df_bg.wasm and v2/models/DeepFilterNet3_onnx.tar.gz to the configured base.
FROM alpine:3.20 AS noise-assets
ARG DFN_CDN=https://cdn.mezon.ai/AI/models/datas/noise_suppression/deepfilternet3
RUN apk add --no-cache curl \
 && mkdir -p /noise/deepfilternet3/v2/pkg /noise/deepfilternet3/v2/models \
 && curl -fsSL "$DFN_CDN/v2/pkg/df_bg.wasm" -o /noise/deepfilternet3/v2/pkg/df_bg.wasm \
 && curl -fsSL "$DFN_CDN/v2/models/DeepFilterNet3_onnx.tar.gz" -o /noise/deepfilternet3/v2/models/DeepFilterNet3_onnx.tar.gz

# Build the SPA, then serve it as static files via nginx.
FROM node:20-alpine AS build

# pnpm ВШИТ В СВОЙ СЛОЙ, а не подтягивается лениво внутри `pnpm install`. corepack качает тарбол
# pnpm при ПЕРВОМ запуске `pnpm`, то есть внутри слоя с install, а тот сбрасывается ЛЮБОЙ правкой
# package.json — хоть добавлением файла в перечень тестов. Пакеты при этом лежат в тёплом
# /pnpm/store и сети не просят, но за одним тарболом pnpm сборка шла в registry.npmjs.org и из РФ
# ловила ConnectTimeout (ран 1414, джоба client). Этот слой зависит ТОЛЬКО от PNPM_VERSION.
# Ниже сеть для corepack выключена совсем: если PNPM_VERSION разъедется с `packageManager` в
# package.json, сборка упадёт сразу и внятно, а не 10-секундным таймаутом на чужой реестр.
# NPM_REGISTRY — шов под зеркало homelab; по умолчанию официальный реестр, чтобы сборка снаружи
# (публичный репо) работала без настроек. Подробности → docs/codemap/ci.md.
ARG PNPM_VERSION=9.12.3
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME=/pnpm \
    COREPACK_HOME=/corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    NPM_CONFIG_REGISTRY=$NPM_REGISTRY \
    NPM_CONFIG_UPDATE_NOTIFIER=false
ENV PATH="$PNPM_HOME:$PATH"
RUN for i in 1 2 3; do corepack enable && corepack prepare "pnpm@$PNPM_VERSION" --activate && break; \
      echo "corepack: попытка $i не удалась, повтор через 5с"; sleep 5; done; pnpm --version
ENV COREPACK_ENABLE_NETWORK=0

WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/client/package.json ./apps/client/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter "@gusvoice/client..."

COPY packages/shared ./packages/shared
COPY apps/client ./apps/client
RUN pnpm --filter @gusvoice/client build

FROM nginx:alpine AS runtime
# Provenance — GHCR auto-links this package to the repo (Package → repository) from this label.
LABEL org.opencontainers.image.source="https://github.com/Gleb1290/gusvoice" \
      org.opencontainers.image.description="GusVoice web client — self-hosted voice/text/screen-share"
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/client/docker-entrypoint.sh /docker-entrypoint.d/40-gusvoice-config.sh
RUN chmod +x /docker-entrypoint.d/40-gusvoice-config.sh
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
COPY --from=noise-assets /noise /usr/share/nginx/html/noise
EXPOSE 80
