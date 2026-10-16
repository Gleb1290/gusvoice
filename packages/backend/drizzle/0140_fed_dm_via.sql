-- ЛС между инстансами, этап Э5 часть 1 (#141, docs/dm/FEDERATION.md §1.5, §4 п. 1 (б)): «мой дом лежит — пишу через инстанс
-- собеседника». Только добавления: две колонки с NULL по умолчанию (прежние строки — обычные сообщения) и две новые таблицы.
--
-- У инстанса собеседника: сообщение человека соседа, принятое по долгой сессии, помечено via_instance_id = дом автора и
-- via_state = 'pending' до решения дома ('confirmed' / 'unverified'; отвергнутое становится надгробием).
-- У дома автора: принятое своим после сверки — via_instance_id = инстанс, через который прошло, via_state = 'confirmed'.
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS via_instance_id text;
ALTER TABLE conversation_messages ADD COLUMN IF NOT EXISTS via_state text;
CREATE INDEX IF NOT EXISTS conversation_messages_via_pending_idx
  ON conversation_messages (via_instance_id) WHERE via_state = 'pending';

-- Дом автора: «через»-сообщения наших людей, забранные у соседа и ждущие отчёта клиента.
CREATE TABLE IF NOT EXISTS fed_via_pending (
  message_id text PRIMARY KEY,
  instance_id text NOT NULL,
  conversation_id text NOT NULL,
  author_id text NOT NULL,
  client_id text,
  entity jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- Дом автора: отчёт клиента «это я отправил в обход» (client_id + отпечаток), ждёт сообщения от соседа.
CREATE TABLE IF NOT EXISTS fed_via_claims (
  user_id text NOT NULL,
  client_id text NOT NULL,
  conversation_id text NOT NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, client_id)
);

-- Дом автора: когда клиент человека последний раз отчитывался (отчёт = вся очередь отправленного в обход; «через»-сообщение,
-- пришедшее до отчёта и не названное в нём, через час считается лишним).
CREATE TABLE IF NOT EXISTS fed_via_reports (
  user_id text PRIMARY KEY,
  reported_at timestamptz NOT NULL DEFAULT now()
);
