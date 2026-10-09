-- Общие медиа беседы (08.10, #211, G29, признак `media1`): «Медиа / Файлы / Ссылки / GIF / Голосовые» в профиле, как у
-- Telegram (`inputMessagesFilterPhotoVideo` / `Document` / `Url` / `Gif` / `Voice`).
--
-- Вид вложения считается из того, что уже лежит в сообщении (`conversation_messages.attachments`: `contentType`,
-- огибающая голосового `waveform`, подсказки `gif` и `asFile`), ссылки — из текста. Отдельной таблицы нет: старые
-- сообщения попадают в списки сами, без прохода по истории, а запись (отправка, пересылка, отложенные, федерация) не
-- меняется. Правила те же, что `shared/sharedMedia.ts` (`sharedMediaKindOf`, `messageLinks`) — менять вместе.
--
-- `gv_media_count(attachments, kind)` — сколько вложений сообщения такого вида: `media` — фото и видео (не «как файл»,
-- не GIF), `gif`, `voice` — голосовое (есть огибающая и звук), `file` — всё остальное. `gv_has_link(content)` — в тексте
-- есть ссылка http(s). Обе IMMUTABLE: на них построены частичные индексы (беседа, ключ порядка) по каждому виду.
--
-- Только добавление: функции и индексы, данные не трогаются.
CREATE OR REPLACE FUNCTION gv_media_count(att jsonb, kind text) RETURNS integer
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT count(*)::int
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(att) = 'array' THEN att ELSE '[]'::jsonb END) AS e
  WHERE CASE
    WHEN COALESCE(jsonb_typeof(e -> 'waveform') = 'array' AND jsonb_array_length(e -> 'waveform') > 0, false)
      AND COALESCE(e ->> 'contentType', '') LIKE 'audio/%' THEN kind = 'voice'
    WHEN COALESCE(e -> 'gif' = 'true'::jsonb, false) THEN kind = 'gif'
    WHEN (COALESCE(e ->> 'contentType', '') LIKE 'image/%' OR COALESCE(e ->> 'contentType', '') LIKE 'video/%')
      AND NOT COALESCE(e -> 'asFile' = 'true'::jsonb, false) THEN kind = 'media'
    ELSE kind = 'file'
  END
$$;

CREATE OR REPLACE FUNCTION gv_has_link(content text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT COALESCE(content ~* 'https?://[^[:space:]<>"]', false)
$$;

CREATE INDEX IF NOT EXISTS conv_messages_media_idx ON conversation_messages (conversation_id, sort_key)
  WHERE gv_media_count(attachments, 'media') > 0;
CREATE INDEX IF NOT EXISTS conv_messages_files_idx ON conversation_messages (conversation_id, sort_key)
  WHERE gv_media_count(attachments, 'file') > 0;
CREATE INDEX IF NOT EXISTS conv_messages_gifs_idx ON conversation_messages (conversation_id, sort_key)
  WHERE gv_media_count(attachments, 'gif') > 0;
CREATE INDEX IF NOT EXISTS conv_messages_voice_idx ON conversation_messages (conversation_id, sort_key)
  WHERE gv_media_count(attachments, 'voice') > 0;
CREATE INDEX IF NOT EXISTS conv_messages_links_idx ON conversation_messages (conversation_id, sort_key)
  WHERE gv_has_link(content);
