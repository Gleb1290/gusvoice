-- Поиск по беседе ЛС (G05, #211, признак `search1`): `GET /api/conv/:id/search` ищет `content ILIKE '%слово%'`. Без индекса
-- это проход по всей беседе; триграммный GIN (`pg_trgm`) ускоряет ILIKE с подстрокой. Только добавление: старый код индекса
-- не знает. Расширения может не быть (сборка Postgres без contrib, PGlite в тестах) или прав на него — тогда миграция
-- проходит без индекса, поиск работает и так, только медленнее.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX IF NOT EXISTS conversation_messages_content_trgm
    ON conversation_messages USING gin (content gin_trgm_ops);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_trgm unavailable, conversation search runs without index: %', SQLERRM;
END
$$;
