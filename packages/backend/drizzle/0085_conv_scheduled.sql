-- ЛС, раунд 12, серверный шаг С4 (05.10, #211, признак `conv9`): отложенные сообщения, как в Telegram, — «Отправить
-- позже» (`send_at`) и «Когда будет в сети» (`when_online`: уйдёт, когда собеседник 1:1 появится в сети).
--
-- Лежат на сервере и уходят, даже если автор не в сети: планировщик бэкенда (`scheduled.ts`) раз в несколько секунд
-- берёт созревшие строки (`FOR UPDATE SKIP LOCKED` — несколько процессов не возьмут одну строку) и отправляет обычной
-- отправкой: сообщение и удаление строки — одной транзакцией, повтор упавшей — с отсрочкой (`attempts`,
-- `next_attempt_at`), без вечного цикла: попытки кончились или писать некому — `failed_at` + `fail_reason`, строка
-- остаётся у автора с отметкой «не отправлено».
--
-- Видит строки только автор. Он ссылается на участие в беседе (как владелец `attachments` и закрепы), а не на `users`:
-- беседа уходит — уходят и её отложенные (каскад); удаление аккаунта стирает их явно (`accountRows.anonymizeAccountRows`).
-- `client_id` — id отправки при создании (повтор создания — без дубля); с ним же уйдёт и само сообщение.
-- `payload_hash` — отпечаток запроса создания, не меняется при правке.
--
-- Только добавление: старый бэкенд (откат) таблицу не читает — отложенные просто ждут, пока вернётся новый.
CREATE TABLE IF NOT EXISTS conversation_scheduled (
  id text PRIMARY KEY,
  conversation_id text NOT NULL,
  author_id text NOT NULL,
  client_id text NOT NULL,
  payload_hash text NOT NULL,
  content text NOT NULL,
  reply_to_id text REFERENCES conversation_messages(id) ON DELETE SET NULL,
  silent boolean NOT NULL DEFAULT false,
  send_at timestamptz,
  when_online boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz,
  last_error text,
  failed_at timestamptz,
  fail_reason text,
  -- Режим — ровно один: время ИЛИ «когда будет в сети».
  CONSTRAINT conversation_scheduled_mode_check CHECK ((send_at IS NOT NULL) <> when_online),
  CONSTRAINT conversation_scheduled_fail_check CHECK (fail_reason IS NULL OR fail_reason IN ('peer-gone', 'error')),
  FOREIGN KEY (conversation_id, author_id) REFERENCES conversation_members (conversation_id, user_id) ON DELETE CASCADE
);
-- Повтор создания по id отправки; заодно — все строки автора (предел на человека, удаление аккаунта).
CREATE UNIQUE INDEX IF NOT EXISTS conversation_scheduled_client_uq ON conversation_scheduled (author_id, client_id);
-- Список и предел в беседе.
CREATE INDEX IF NOT EXISTS conversation_scheduled_owner_idx ON conversation_scheduled (conversation_id, author_id);
-- Такт планировщика: созревшие по времени и ждущие собеседника в сети.
CREATE INDEX IF NOT EXISTS conversation_scheduled_due_idx ON conversation_scheduled (send_at)
  WHERE failed_at IS NULL AND send_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversation_scheduled_online_idx ON conversation_scheduled (conversation_id)
  WHERE failed_at IS NULL AND when_online;

-- Строка журнала «мой список отложенных в беседе изменился» (`message_id` пуст; только автору). Старый бэкенд (откат) такие
-- строки читает как любые: беседа попадает в догонку сводкой.
ALTER TABLE user_changes DROP CONSTRAINT IF EXISTS user_changes_kind_check;
ALTER TABLE user_changes ADD CONSTRAINT user_changes_kind_check CHECK (kind IN ('msg', 'read', 'conv', 'draft', 'pin', 'sched'));
