-- ЛС (#211, 07.10, волна 5 плана «телеграмности», G24, признак сервера `reactunread1`): непрочитанные реакции на мои
-- сообщения («♥ 2» над «вниз», значок ♥ в строке списка), как у Telegram (`HistoryItem::markReactionsRead`).
--
-- `conversation_message_reactions.seen_at` — когда АВТОР сообщения увидел эту реакцию (показал сообщение на экране или
-- нажал «Прочитать все»). `NULL` — не видел. Непрочитанной считается реакция ДРУГОГО человека на моё сообщение (своя
-- реакция на своё — сразу «увидена» при записи). Все прежние строки помечаются увиденными: старые реакции строки списка
-- не «зажигают». Признак в сводке — `ConvSummary.unreadReactions`, в сообщении — `ConvMessage.reactionUnread` (добавлением,
-- правило 11).
--
-- Только добавление: колонка допускает `NULL`; частичный индекс держит только непрочитанные (их единицы).
ALTER TABLE conversation_message_reactions ADD COLUMN IF NOT EXISTS seen_at timestamptz;
UPDATE conversation_message_reactions SET seen_at = created_at WHERE seen_at IS NULL;
CREATE INDEX IF NOT EXISTS conversation_message_reactions_unseen
  ON conversation_message_reactions (message_id) WHERE seen_at IS NULL;
