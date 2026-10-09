-- gv:no-transaction
-- Скорость «Частых» (09.10, #211, ревью безопасности G35): `frequentConversations` (`conversations.ts`) берёт МОИ сообщения
-- за 90 суток (`author_id = me AND created_at >= now() - 90 days`). Индекс 0114 `(author_id, conversation_id)` отдаёт ВСЕ мои
-- сообщения за всё время — у давнего пользователя это сотни тысяч строк на каждый вызов. С ведущим автором и временем вторым
-- Postgres читает только окно.
--
-- Частичный, как 0114: только живые обычные сообщения (`deleted_at IS NULL AND service IS NULL`) — те же условия, что в
-- запросе. `CONCURRENTLY` — без блокировки записи в беседы, отсюда файл без транзакции (`-- gv:no-transaction`, шаги
-- `-- gv:step`, `db/index.ts` `migrationPlan`); любой шаг можно повторить, если запуск упал посередине.
-- Только добавление: индекс, данные не трогаются.

-- gv:step
-- Прошлая попытка `CONCURRENTLY` упала посередине — остался невалидный индекс; `IF NOT EXISTS` его иначе не пересоберёт.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('conversation_messages_author_time_idx') AND NOT indisvalid) THEN
    DROP INDEX conversation_messages_author_time_idx;
  END IF;
END
$$;

-- gv:step
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversation_messages_author_time_idx
  ON conversation_messages (author_id, created_at)
  WHERE deleted_at IS NULL AND service IS NULL;
