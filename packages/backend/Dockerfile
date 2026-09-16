# GusVoice backend. Two-stage: the build stage bundles our TypeScript (backend src +
# the private @gusvoice/shared) into a single MINIFIED dist/index.js via esbuild; the
# runtime stage carries only that bundle + prod node_modules + the SQL migrations — NO
# readable source. This is what makes the published image safe to ship to a public
# registry (Stage-1 closed-source turnkey). npm deps stay external (installed --prod),
# so Fastify/pg/etc. run exactly as they did under tsx.

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
COPY packages/backend/package.json ./packages/backend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --filter "@gusvoice/backend..."
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend
RUN pnpm --filter @gusvoice/backend bundle

# ---- runtime: prod deps + minified bundle + migrations (no source) ----
FROM node:20-alpine AS runtime
# Provenance — GHCR auto-links this package to the repo (Package → repository) from this label.
LABEL org.opencontainers.image.source="https://github.com/Gleb1290/gusvoice" \
      org.opencontainers.image.description="GusVoice backend — self-hosted voice/text/screen-share"
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
COPY packages/backend/package.json ./packages/backend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --store-dir=/pnpm/store --filter "@gusvoice/backend..."
# The minified app bundle (our code, obfuscated) + the schema migrations (SQL DDL only).
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY packages/backend/drizzle ./packages/backend/drizzle

WORKDIR /app/packages/backend
# Версия для вкладки «Инстанс» и кнопки «Обновить» (О2б): CI master кладёт `master-<коммит>`, выгрузка выпуска —
# `vX.Y.Z`, локальная сборка остаётся `dev`. Объявлена В КОНЦЕ: меняется каждую сборку и не должна сбрасывать кэш
# слоёв с установкой зависимостей выше.
ARG GV_VERSION=dev
ENV GV_VERSION=$GV_VERSION
ENV BACKEND_PORT=4000
# Source tree is gone in this image, so tell the migrator where the SQL lives (see db/index.ts).
ENV MIGRATIONS_DIR=/app/packages/backend/drizzle
EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:4000/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/index.js"]
