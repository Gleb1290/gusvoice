# Бот GusVoice в контейнере. Сборка из каталога examples/bots (контекст — этот каталог):
#   docker build -f docker/Dockerfile --build-arg BOT_FILE=echo.ts -t my-gusvoice-bot .
#   docker run -d --name my-gusvoice-bot --restart unless-stopped --env-file ./bot.env my-gusvoice-bot
# Токен передаётся ТОЛЬКО окружением (--env-file / secrets), в образ не запекается.
# Для голоса (music.ts) нужен ffmpeg и glibc-образ (Alpine не подходит нативному модулю):
#   добавьте строку  RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
#   и установите  @gusvoice/bot-voice@0.1.0  вместе с @gusvoice/bot.
FROM node:24-bookworm-slim

WORKDIR /app
# Точные версии (правило проекта). Пока пакет не опубликован в npm — подложите tarball (packages/bot-sdk/README.md, "Install").
RUN npm init -y >/dev/null && npm pkg set type=module \
 && npm install --omit=dev --no-audit --no-fund @gusvoice/bot@0.1.0 tsx@4.22.4

ARG BOT_FILE=echo.ts
COPY ${BOT_FILE} ./bot.ts

# Не root.
USER node
# Образ собран без токена и без секретов: всё берётся из окружения контейнера.
CMD ["node_modules/.bin/tsx", "bot.ts"]
