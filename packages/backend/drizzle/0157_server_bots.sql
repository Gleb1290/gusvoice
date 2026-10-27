-- Боты на серверах (#231). Связь «бот на сервере» и управляемая роль висят на ЧЛЕНСТВЕ: любой выход бота с сервера
-- (кик, бан, leaveChat, удаление бота или его владельца — accountRows.ts) каскадно уносит обе строки, без правок во всех входах.
CREATE TABLE IF NOT EXISTS server_bots (
  server_id  text NOT NULL,
  bot_id     text NOT NULL,
  read_all   boolean NOT NULL DEFAULT false,
  -- Кто добавил. FK на users с SET NULL: удаление аккаунта добавившего ссылку обнуляет, строка бота остаётся.
  added_by   text REFERENCES users(id) ON DELETE SET NULL,
  added_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, bot_id),
  CONSTRAINT server_bots_member_fk FOREIGN KEY (server_id, bot_id)
    REFERENCES server_members(server_id, user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS server_bots_bot_idx ON server_bots(bot_id);

-- Управляемая роль бота: снимается вместе с его членством (MATCH SIMPLE — у обычных ролей NULL не проверяется).
ALTER TABLE roles ADD COLUMN IF NOT EXISTS managed_bot_id text;
DO $$ BEGIN
  ALTER TABLE roles ADD CONSTRAINT roles_managed_bot_fk FOREIGN KEY (server_id, managed_bot_id)
    REFERENCES server_members(server_id, user_id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS roles_managed_bot_uniq ON roles(server_id, managed_bot_id) WHERE managed_bot_id IS NOT NULL;

-- Кнопки под сообщением бота в КАНАЛЕ (как conversation_messages.keyboard в 0155). NULL — кнопок нет.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS keyboard jsonb;
-- Команды по областям (#231): {"all_private_chats": [...], "all_group_chats": [...]}; нет ключа — берётся `commands` (default).
ALTER TABLE bots ADD COLUMN IF NOT EXISTS commands_scoped jsonb NOT NULL DEFAULT '{}'::jsonb;
-- Пакетная доставка на адрес (#231, по согласию бота: setWebhook batch=true) — тело POST массивом.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS webhook_batch boolean NOT NULL DEFAULT false;
-- Сколько событий журнал бота срезал потолком (#231): бот видит потерю в getWebhookInfo/getMe.
ALTER TABLE bots ADD COLUMN IF NOT EXISTS dropped_update_count integer NOT NULL DEFAULT 0;
