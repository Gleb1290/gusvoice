# DeepFilterNet3 assets for deepfilternet3-noise-filter@1.2.1, served under /noise/.
# Both files match the bytes in the published GusVoice client v0.9.73. The v2 SIMD
# WASM comes from a commit-pinned mirror and the ONNX archive from DeepFilterNet.
FROM alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS noise-assets
ARG DFN_WASM_URL=https://huggingface.co/trysem/DeepFilterNet3/resolve/fcc7871ea01f25df17997a6b8c25f4641f470eb1/df_bg.wasm
ARG DFN_MODEL_URL=https://raw.githubusercontent.com/Rikorose/DeepFilterNet/v0.5.6/models/DeepFilterNet3_onnx.tar.gz
# Create traversable directories before applying file-only permissions with ADD.
RUN mkdir -p /noise/deepfilternet3/v2/pkg /noise/deepfilternet3/v2/models
ADD --chmod=0644 --checksum=sha256:e133417d08bee384d8e60de27efa91da3d858920ed800d4794d490a177300600 \
    ${DFN_WASM_URL} /noise/deepfilternet3/v2/pkg/df_bg.wasm
ADD --chmod=0644 --checksum=sha256:c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616 \
    ${DFN_MODEL_URL} /noise/deepfilternet3/v2/models/DeepFilterNet3_onnx.tar.gz

# Build the SPA, then serve it as static files via nginx.
FROM node:24.22.3-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build

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
# Заплатки `pnpm.patchedDependencies` (корневой package.json): без них `pnpm install --frozen-lockfile` падает.
COPY patches ./patches
COPY packages/shared/package.json ./packages/shared/
COPY apps/client/package.json ./apps/client/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter "@gusvoice/client..."

COPY packages/shared ./packages/shared
COPY apps/client ./apps/client
RUN pnpm --filter @gusvoice/client build

FROM nginx:1.30.8-alpine@sha256:8eb04fe3b385090e9aa02961f77398ad09b6bf33ab07f6669a5bb7acce22c0d3 AS runtime
# Provenance — GHCR auto-links this package to the repo (Package → repository) from this label.
LABEL org.opencontainers.image.source="https://github.com/Gleb1290/gusvoice" \
      org.opencontainers.image.description="GusVoice web client — self-hosted voice/text/screen-share"
COPY apps/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY apps/client/docker-entrypoint.sh /docker-entrypoint.d/40-gusvoice-config.sh
RUN chmod +x /docker-entrypoint.d/40-gusvoice-config.sh
COPY --from=build /app/apps/client/dist /usr/share/nginx/html
COPY --from=noise-assets /noise /usr/share/nginx/html/noise
EXPOSE 80
