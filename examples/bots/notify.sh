#!/bin/sh
# Уведомление себе от бота GusVoice одной строкой curl (без SDK): ./notify.sh "Бэкап готов"
#
#   GUSVOICE_API       — адрес API инстанса: поле apiUrl в https://<ваш инстанс>/config.json
#   GUSVOICE_BOT_TOKEN — токен бота (gvb_…), только из окружения, не в скрипте
#   GUSVOICE_CHAT_ID   — id беседы с ботом: напишите боту /whoami (vps-panel.ts) или возьмите chat.id из getUpdates
#
# Бот не пишет первым: сначала откройте с ним беседу сами. `--retry 3` переждёт 429 по заголовку Retry-After. Ответ — JSON {"ok":true,...} или {"ok":false,"description":...}.
curl -sS --retry 3 -X POST "$GUSVOICE_API/api/bot/v1/sendMessage" -H "Authorization: Bot $GUSVOICE_BOT_TOKEN" --data-urlencode "chat_id=$GUSVOICE_CHAT_ID" --data-urlencode "text=$*"
