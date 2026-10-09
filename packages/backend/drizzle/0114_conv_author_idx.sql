-- gv:no-transaction
-- Скорость списка бесед (08.10, #211, ревью): «писал ли я в эту беседу» — для плашки незнакомца (`strangerSql` в
-- `conversations.ts`: я не ответил ни разу). Без индекса по автору Postgres превращал `NOT EXISTS` по моим сообщениям в
-- хеш-подплан с полным проходом всей `conversation_messages` (~80 мс на 700 тыс. строк и растёт с инстансом); с ним —
-- проба по индексу на каждую беседу (~16 мс на том же засеве).
--
-- Частичный: только живые обычные сообщения — ровно то, что проверяет `strangerSql` (`deleted_at IS NULL AND service IS
-- NULL`). Ведущий столбец — автор: годится и пробе «автор + беседа», и проходу «все мои сообщения».
--
-- 08.10 (решение владельца 16): строится `CONCURRENTLY` — без блокировки записи в таблицу на время сборки, поэтому файл без
-- транзакции (`-- gv:no-transaction`, шаги `-- gv:step`, `db/index.ts` `migrationPlan`). Базы, где файл уже применён прежним
-- текстом (обычный `CREATE INDEX` в транзакции — индекс валиден), его не перечитывают: раннер помнит миграции по имени.
-- Только добавление: индекс, данные не трогаются.

-- gv:step
-- Прошлая попытка `CONCURRENTLY` упала посередине — остался невалидный индекс; `IF NOT EXISTS` его иначе не пересоберёт.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('conversation_messages_author_conv_idx') AND NOT indisvalid) THEN
    DROP INDEX conversation_messages_author_conv_idx;
  END IF;
END
$$;

-- gv:step
CREATE INDEX CONCURRENTLY IF NOT EXISTS conversation_messages_author_conv_idx
  ON conversation_messages (author_id, conversation_id)
  WHERE deleted_at IS NULL AND service IS NULL;
