# GusVoice presence service. Two-stage: build bundles our TypeScript (presence src +
# private @gusvoice/shared) into a single MINIFIED dist/index.js; runtime carries only
# that bundle + prod node_modules — NO readable source (Stage-1 closed-source turnkey).
# npm deps stay external (installed --prod), so they run exactly as under tsx.

# ---- build: install (incl. esbuild) + bundle ----
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
COPY packages/presence/package.json ./packages/presence/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter "@gusvoice/presence..."
COPY packages/shared ./packages/shared
COPY packages/presence ./packages/presence
RUN pnpm --filter @gusvoice/presence bundle

# ---- runtime: prod deps + minified bundle (no source) ----
FROM node:20-alpine AS runtime
# Provenance — GHCR auto-links this package to the repo (Package → repository) from this label.
LABEL org.opencontainers.image.source="https://github.com/Gleb1290/gusvoice" \
      org.opencontainers.image.description="GusVoice presence service — self-hosted voice/text/screen-share"
# Тот же вшитый pnpm, что и в build-стадии (зачем — см. комментарий выше).
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
COPY packages/presence/package.json ./packages/presence/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir=/pnpm/store --filter "@gusvoice/presence..."
COPY --from=build /app/packages/presence/dist ./packages/presence/dist

WORKDIR /app/packages/presence
ENV PRESENCE_PORT=4001
EXPOSE 4001

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4001/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
