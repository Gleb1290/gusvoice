-- gv:no-transaction
-- Кружки в общих медиа — во вкладке «Голосовые», не в «Медиа» (08.10, #211, G29 + G68, решение владельца 19): как у Telegram
-- (фильтр `inputMessagesFilterRoundVoice` — голосовые и видеосообщения вместе; Android `MediaDataController.MEDIA_AUDIO`,
-- tdesktop `Storage::SharedMediaType::RoundVoiceFile`).
--
-- `gv_media_count` (0108) получает правило «вложение с `round: true` и видео — вид `voice`» ПЕРВЫМ, до gif и media. Те же
-- правила — `shared/sharedMedia.ts` `sharedMediaKindOf`: менять вместе.
--
-- 🔴 Функция IMMUTABLE и стоит в условиях частичных индексов `conv_messages_media_idx` / `conv_messages_voice_idx`: условие
-- индекса вычислено при записи строки, и после замены функции старые кружки остались бы в индексе «Медиа» и не попали бы в
-- индекс «Голосовые» (а условие, совпавшее с условием индекса, Postgres при чтении по индексу заново не проверяет). Поэтому
-- оба индекса пересобираются. `CONCURRENTLY` — без блокировки записи в беседы, отсюда файл без транзакции
-- (`-- gv:no-transaction`, шаги `-- gv:step`, `db/index.ts` `migrationPlan`); любой шаг можно повторить, если запуск упал
-- посередине (`DROP … IF EXISTS` сносит и недостроенный, невалидный индекс). Индексы файлов, GIF и ссылок не меняются.
-- Только добавление по смыслу протокола: данные сообщений не трогаются.

-- gv:step
CREATE OR REPLACE FUNCTION gv_media_count(att jsonb, kind text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT count(*)::int
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(att) = 'array' THEN att ELSE '[]'::jsonb END) AS e
  WHERE CASE
    WHEN COALESCE(e -> 'round' = 'true'::jsonb, false)
      AND COALESCE(e ->> 'contentType', '') LIKE 'video/%' THEN kind = 'voice'
    WHEN COALESCE(jsonb_typeof(e -> 'waveform') = 'array' AND jsonb_array_length(e -> 'waveform') > 0, false)
      AND COALESCE(e ->> 'contentType', '') LIKE 'audio/%' THEN kind = 'voice'
    WHEN COALESCE(e -> 'gif' = 'true'::jsonb, false) THEN kind = 'gif'
    WHEN (COALESCE(e ->> 'contentType', '') LIKE 'image/%' OR COALESCE(e ->> 'contentType', '') LIKE 'video/%')
      AND NOT COALESCE(e -> 'asFile' = 'true'::jsonb, false) THEN kind = 'media'
    ELSE kind = 'file'
  END
$$;

-- gv:step
DROP INDEX CONCURRENTLY IF EXISTS conv_messages_media_idx;

-- gv:step
CREATE INDEX CONCURRENTLY IF NOT EXISTS conv_messages_media_idx ON conversation_messages (conversation_id, sort_key)
  WHERE gv_media_count(attachments, 'media') > 0;

-- gv:step
DROP INDEX CONCURRENTLY IF EXISTS conv_messages_voice_idx;

-- gv:step
CREATE INDEX CONCURRENTLY IF NOT EXISTS conv_messages_voice_idx ON conversation_messages (conversation_id, sort_key)
  WHERE gv_media_count(attachments, 'voice') > 0;
