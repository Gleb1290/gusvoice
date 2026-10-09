-- gv:no-transaction
-- Поиск по серверам (G35, #211, признак `srvsearch1`): `GET /api/search/servers` ищет `messages.content ILIKE '%слово%'` сразу по
-- каналам всех моих серверов. Без индекса это проход по всей таблице сообщений; триграммный GIN (`pg_trgm`) ускоряет ILIKE с
-- подстрокой. Только добавление: старый код индекса не знает. Расширения может не быть (сборка Postgres без contrib, PGlite в
-- тестах) или прав на него — тогда миграция проходит без индекса, поиск работает и так, только медленнее.
--
-- 08.10 (решение владельца 16): индекс строится `CONCURRENTLY` — сборка GIN по всей `messages` не запирает запись в каналы.
-- Поэтому файл без транзакции (`-- gv:no-transaction`, шаги `-- gv:step`, `db/index.ts` `migrationPlan`): `CONCURRENTLY` нельзя
-- ни в транзакции, ни в блоке `DO`. Необязательные шаги (`optional`) не валят миграцию — так переживается отсутствие
-- `pg_trgm`. Базы, где файл уже применён прежним текстом (индекс в транзакции — валиден), его не перечитывают.

-- gv:step optional
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- gv:step
-- Прошлая попытка `CONCURRENTLY` упала посередине — остался невалидный индекс; `IF NOT EXISTS` его иначе не пересоберёт.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('messages_content_trgm') AND NOT indisvalid) THEN
    DROP INDEX messages_content_trgm;
  END IF;
END
$$;

-- gv:step optional
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_content_trgm
  ON messages USING gin (content gin_trgm_ops);

-- gv:step
-- Необязательная сборка упала посередине (не «нет расширения», а, скажем, отмена) — невалидный индекс не оставляем: его
-- обновляла бы каждая запись в `messages`, а читать его Postgres не стал бы. Поиск без индекса просто медленнее.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_index WHERE indexrelid = to_regclass('messages_content_trgm') AND NOT indisvalid) THEN
    DROP INDEX messages_content_trgm;
  END IF;
END
$$;
