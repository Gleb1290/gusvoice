-- Боты (#229, этап 1 — ЛС; план docs/bots-plan.md). Только добавления: старый код новых таблиц и колонок не знает.
--
-- bots — настоящий бот: строка в users (`bot=true`, как у автора вебхука с 0151) + эта запись. Отличить бота от автора
--   вебхука — по наличию строки здесь. Токен входа хранится ТОЛЬКО хешем (sha256 от 32 случайных байт, префикс `gvb_`).
--   webhook_secret — НЕ токен входа, а общий секрет подписи доставки (HMAC-SHA256), который задал сам бот в `setWebhook`:
--   сервер обязан им подписывать, поэтому хеш не годится. Утечка базы даёт подделать доставку только этому боту.
--   Удаление бота — как удаление аккаунта (users.deleted_at, строка обезличена); запись остаётся с непригодным хешем.
CREATE TABLE IF NOT EXISTS bots (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  token_created_at timestamptz NOT NULL DEFAULT now(),
  description text NOT NULL DEFAULT '',
  about text NOT NULL DEFAULT '',
  public boolean NOT NULL DEFAULT false,
  webhook_url text,
  webhook_secret text,
  webhook_failures integer NOT NULL DEFAULT 0,
  webhook_last_error text,
  webhook_last_error_at timestamptz,
  webhook_disabled_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS bots_token_hash_idx ON bots (token_hash);
CREATE INDEX IF NOT EXISTS bots_owner_idx ON bots (owner_id);

-- bot_updates — журнал событий бота (getUpdates / WS / доставка на адрес). update_id общий на инстанс и только растёт —
--   внутри одного бота это и есть порядок. Подтверждённое (offset, 2xx от адреса) удаляется; хранение 24 ч и потолок на
--   бота держит уборка (`bots/botStore.ts` `pruneBotUpdates`).
CREATE TABLE IF NOT EXISTS bot_updates (
  update_id bigserial PRIMARY KEY,
  bot_id text NOT NULL REFERENCES bots(user_id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_updates_bot_idx ON bot_updates (bot_id, update_id);
CREATE INDEX IF NOT EXISTS bot_updates_created_idx ON bot_updates (created_at);

-- Карточки в сообщениях ЛС (бот шлёт `embeds`, формат тот же, что у вебхука канала — 0153). NULL — карточек нет.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS embeds jsonb;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS embeds_fallback boolean NOT NULL DEFAULT false;
