-- Существующий журнал учитывается до включения триггеров. DML ждёт окончания транзакции миграции.
LOCK TABLE bot_updates IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE bots ADD COLUMN journal_size integer NOT NULL DEFAULT 0 CHECK (journal_size >= 0);

UPDATE bots b SET journal_size = existing.n
FROM (SELECT bot_id, count(*)::int AS n FROM bot_updates GROUP BY bot_id) existing
WHERE b.user_id = existing.bot_id;

CREATE FUNCTION count_bot_updates_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bots b SET journal_size = b.journal_size + added.n
  FROM (SELECT bot_id, count(*)::int AS n FROM inserted_updates GROUP BY bot_id) added
  WHERE b.user_id = added.bot_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER bot_updates_count_insert
AFTER INSERT ON bot_updates REFERENCING NEW TABLE AS inserted_updates
FOR EACH STATEMENT EXECUTE FUNCTION count_bot_updates_inserted();

CREATE FUNCTION count_bot_updates_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  trimming boolean := current_setting('gusvoice.trimming_bot_journal', true) = 'on';
BEGIN
  UPDATE bots b
  SET journal_size = b.journal_size - removed.n,
      dropped_update_count = CASE WHEN trimming
        THEN least(b.dropped_update_count::bigint + removed.n, 2147483647)::int
        ELSE b.dropped_update_count END
  FROM (SELECT bot_id, count(*)::int AS n FROM deleted_updates GROUP BY bot_id) removed
  WHERE b.user_id = removed.bot_id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER bot_updates_count_delete
AFTER DELETE ON bot_updates REFERENCING OLD TABLE AS deleted_updates
FOR EACH STATEMENT EXECUTE FUNCTION count_bot_updates_deleted();

CREATE FUNCTION reset_bot_updates_count() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE bots SET journal_size = 0 WHERE journal_size <> 0;
  RETURN NULL;
END;
$$;

CREATE TRIGGER bot_updates_count_truncate
AFTER TRUNCATE ON bot_updates FOR EACH STATEMENT EXECUTE FUNCTION reset_bot_updates_count();

-- Блокировку строки бота вызывающий берёт раньше записи/удаления. Флаг виден только внутри функции
-- и позволяет DELETE-триггеру обновить размер и потери одним UPDATE, отдельно от штатных подтверждений.
CREATE FUNCTION trim_bot_journal(target_bot text, excess integer) RETURNS integer
LANGUAGE sql SET gusvoice.trimming_bot_journal = 'on' AS $$
  WITH removed AS (
    DELETE FROM bot_updates WHERE update_id = ANY(ARRAY(
      SELECT update_id FROM bot_updates WHERE bot_id = target_bot ORDER BY update_id LIMIT excess
    )) RETURNING 1
  )
  SELECT count(*)::int FROM removed;
$$;
