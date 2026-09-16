#!/bin/sh
# Runs via the nginx image's /docker-entrypoint.d launcher before nginx starts.
# Bakes the deploy-time public URLs into /config.js (read by the SPA at boot).
set -e

# 🔴 Нормализуем ДО подстановки. Значение уходит в config.js как литерал JS и в config.json как
# литерал JSON: `DIAG_ENABLED=yes` дал бы `diagEnabled: yes` (ошибка при загрузке страницы) и
# невалидный JSON — то есть опечатка в одной переменной ломала бы ОБНАРУЖЕНИЕ ИНСТАНСА целиком, а
# заодно и вход в приложение.
# Правило ровно то же, что в env.ts на бэкенде («true» и только «true»), чтобы они не разъехались.
if [ "${DIAG_ENABLED:-}" = "true" ]; then DIAG_FLAG=true; else DIAG_FLAG=false; fi
if [ "${ECONOMY_ENABLED:-}" = "true" ]; then ECONOMY_FLAG=true; else ECONOMY_FLAG=false; fi

cat > /usr/share/nginx/html/config.js <<EOF
window.__GUSVOICE_CONFIG__ = {
  apiUrl: "${VITE_API_URL:-}",
  presenceWs: "${VITE_PRESENCE_WS:-}",
  pushGateway: "${VITE_PUSH_GATEWAY:-}",
  ntfyServer: "${VITE_NTFY_SERVER:-}",
  diagEnabled: ${DIAG_FLAG},
  economyEnabled: ${ECONOMY_FLAG}
};
EOF

# Same values as fetch-able JSON — this is the instance DISCOVERY doc. The generic desktop/mobile
# picker fetches <this-origin>/config.json (cross-origin from tauri://) to learn where the backend,
# presence, and push gateway live, so one prebuilt client can point at any server.
cat > /usr/share/nginx/html/config.json <<EOF
{"apiUrl":"${VITE_API_URL:-}","presenceWs":"${VITE_PRESENCE_WS:-}","pushGateway":"${VITE_PUSH_GATEWAY:-}","ntfyServer":"${VITE_NTFY_SERVER:-}","diagEnabled":${DIAG_FLAG},"economyEnabled":${ECONOMY_FLAG}}
EOF

echo "[gusvoice] wrote /config.js + /config.json (apiUrl=${VITE_API_URL:-}, presenceWs=${VITE_PRESENCE_WS:-}, pushGateway=${VITE_PUSH_GATEWAY:-}, diag=${DIAG_FLAG}, economy=${ECONOMY_FLAG})"
